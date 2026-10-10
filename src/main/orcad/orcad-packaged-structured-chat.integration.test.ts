import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { getDefaultPersistedState } from '../../shared/constants'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { spawnProcess } from '@orca/process-host'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentSessionSubscribeEvent } from '../../shared/agent-session-wire'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { parsePairingCode, type PairingOffer } from '../../shared/pairing'
import {
  AGENT_SESSION_TURN_ITEM_CAPABILITY,
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import {
  sendRemoteRuntimeRequest,
  subscribeRemoteRuntimeRequest,
  type RemoteRuntimeSubscription
} from '../../shared/remote-runtime-client'
import { claudeSessionIdForOrcaSession } from '../claude/claude-structured-session-id'
import { shellEscape } from '../ssh/ssh-connection-utils'
import { materializeOrcadArtifact } from '../ssh/orcad-artifact-materializer'
import {
  hostServerTarget,
  installPackagedOrcadSlotForTests,
  locatePinnedNodeForTests,
  skipForMissingInputs
} from './orcad-node-slot-fixture'
import {
  killChildAndWait,
  killProfileDaemons,
  removeTestRoot
} from './orcad-daemon-teardown-fixture'
import { packagedClaudeChatScenario } from './orcad-structured-chat-scenario'

const pinnedNode = locatePinnedNodeForTests()
const templateDir = process.env.ORCA_ORCAD_TEMPLATE_PATH ?? resolve('out/orcad-template')
const missing = [
  ...(!pinnedNode ? ['a pinned Node runtime'] : []),
  ...(!existsSync(templateDir) ? [templateDir] : [])
]
const skip = skipForMissingInputs('artifact', missing)
const capabilities = [
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  AGENT_SESSION_TURN_ITEM_CAPABILITY
]
const Ready = z.object({
  pairing: z.object({ available: z.literal(true), url: z.string() })
})
const ChildReport = z.object({
  argv: z.array(z.string()),
  execPath: z.string(),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
  userMessages: z.array(z.object({ message: z.object({ content: z.unknown() }) }))
})

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await killProfileDaemons(join(root, 'data'))
    await removeTestRoot(root)
  }
})

function launch(slotDir: string, runtime: string, userData: string, home: string) {
  const child = spawnProcess({
    program: runtime,
    args: [join(slotDir, 'orcad.js'), '--bind', '127.0.0.1', '--port', '0', '--json'],
    cwd: home,
    env: {
      HOME: home,
      CODEX_HOME: join(home, '.codex'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      PATH: [dirname(userData), dirname(runtime), '/usr/bin', '/bin'].join(delimiter),
      SHELL: '/bin/sh',
      LANG: 'en_US.UTF-8',
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_DISABLE_MACOS_LOGIN_SHELL: '1',
      ORCA_USER_DATA: userData
    },
    timeoutMs: null
  })
  let output = ''
  let stderr = ''
  child.stderr.on('data', (data: Buffer) => (stderr += data.toString()))
  const ready = new Promise<PairingOffer>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`No server readiness: ${stderr}`)), 30_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Server exited ${code}: ${stderr}`))
    })
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString()
      if (!output.includes('\n')) {
        return
      }
      clearTimeout(timer)
      try {
        const parsed = Ready.parse(JSON.parse(output.split('\n')[0]!))
        const pairing = parsePairingCode(parsed.pairing.url)
        if (!pairing) {
          throw new Error('Invalid server pairing offer')
        }
        resolveReady(pairing)
      } catch (error) {
        reject(error)
      }
    })
  })
  return { child, ready, stderr: () => stderr }
}

async function call<T>(pairing: PairingOffer, method: string, params: unknown): Promise<T> {
  const response = await sendRemoteRuntimeRequest<T>(
    pairing,
    method,
    params,
    20_000,
    undefined,
    undefined,
    capabilities
  )
  if (!response.ok) {
    throw new Error(`${method}: ${JSON.stringify(response.error)}`)
  }
  return response.result
}

function envelope(
  sessionId: string,
  method: string,
  fields: Record<string, unknown>,
  fence: number | null
) {
  return {
    sessionId,
    clientOperationId: `${Date.now()}-${randomUUID().replaceAll('-', '')}`,
    expectedRuntimeFence: fence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({ method, sessionId, fields })
  }
}

describe.skipIf(skip || process.platform === 'win32')('packaged plain-Node structured chat', () => {
  it('creates, streams and settles a Claude turn through the real paired RPC', async () => {
    if (!pinnedNode) {
      throw new Error('Missing pinned Node runtime')
    }
    const root = realpathSync(
      mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'orca-chat-'))
    )
    roots.push(root)
    const home = join(root, 'home')
    const userData = join(root, 'data')
    mkdirSync(home)
    mkdirSync(userData)
    const materializedSlot = await materializeOrcadArtifact(hostServerTarget(), {
      templateDir,
      cacheRoot: join(root, 'artifacts')
    })
    const { slotDir, runtime } = installPackagedOrcadSlotForTests(
      root,
      pinnedNode,
      materializedSlot
    )
    const script = join(root, 'claude-scripted.mjs')
    const fakeCli = join(root, 'claude')
    writeFileSync(
      script,
      readFileSync(
        resolve('src/main/claude/__fixtures__/claude-agent-sdk-scripted-cli.mjs'),
        'utf8'
      )
    )
    writeFileSync(fakeCli, `#!/bin/sh\nexec ${shellEscape(runtime)} ${shellEscape(script)} "$@"\n`)
    chmodSync(fakeCli, 0o700)
    const sessionId = randomUUID()
    const scenarioPath = join(root, 'scenario.json')
    const reportPath = join(root, 'provider-report.json')
    const partialReplyAckPath = join(root, 'partial-reply-observed')
    writeFileSync(
      scenarioPath,
      JSON.stringify(
        packagedClaudeChatScenario(claudeSessionIdForOrcaSession(sessionId), partialReplyAckPath)
      )
    )
    const state = getDefaultPersistedState(home)
    state.settings = {
      ...state.settings,
      agentStatusHooksEnabled: false,
      nativeChatInheritShellEnvironment: false,
      agentCmdOverrides: { claude: fakeCli },
      agentDefaultEnv: {
        claude: {
          CLAUDE_CONFIG_DIR: join(home, 'claude-config'),
          ORCA_SDK_CONTRACT_SCENARIO_PATH: scenarioPath,
          ORCA_SDK_CONTRACT_REPORT_PATH: reportPath
        }
      }
    }
    writeFileSync(join(userData, 'orca-data.json'), JSON.stringify(state))
    const server = launch(slotDir, runtime, userData, home)
    let subscription: RemoteRuntimeSubscription | undefined
    try {
      const pairing = await server.ready
      const group = await call<{ group: { id: string } }>(pairing, 'projectGroup.create', {
        name: 'Test folder'
      })
      const folder = await call<{ folderWorkspace: { id: string } }>(
        pairing,
        'folderWorkspace.create',
        {
          projectGroupId: group.group.id,
          folderPath: home,
          name: 'Chat test'
        }
      )
      const fields = { worktree: folderWorkspaceKey(folder.folderWorkspace.id), agent: 'claude' }
      const created = await call<unknown>(pairing, 'agentSession.create', {
        ...fields,
        envelope: envelope(sessionId, 'agentSession.create', fields, null)
      })
      expect(created, server.stderr()).toMatchObject({ ok: true })
      const {
        value: { fence }
      } = z.object({ ok: z.literal(true), value: z.object({ fence: z.number() }) }).parse(created)
      const items = new Map<string, AgentJournalRenderItem>()
      const observedText: string[] = []
      const errors: Error[] = []
      subscription = await subscribeRemoteRuntimeRequest<AgentSessionSubscribeEvent>(
        pairing,
        'agentSession.subscribe',
        { sessionId },
        20_000,
        {
          onResponse(response) {
            if (!response.ok) {
              errors.push(new Error(JSON.stringify(response.error)))
              return
            }
            const event = response.result
            const rows =
              event.type === 'batch'
                ? event.batch.items
                : event.type === 'snapshot' || event.type === 'reset'
                  ? event.page.items
                  : []
            for (const row of rows) {
              items.set(row.itemId, row)
              if (row.body?.kind === 'message' && row.body.role === 'assistant') {
                observedText.push(
                  row.body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
                )
                if (observedText.at(-1) === 'Packaged server ') {
                  writeFileSync(partialReplyAckPath, '')
                }
              }
            }
          },
          onError: (error) => errors.push(error)
        },
        { clientCapabilities: capabilities }
      )
      const body = {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'Hello packaged server' }]
      }
      expect(
        await call(pairing, 'agentSession.send', {
          body,
          envelope: envelope(sessionId, 'agentSession.send', { body }, fence)
        }),
        server.stderr()
      ).toMatchObject({ ok: true })
      await vi.waitFor(
        () => {
          expect(errors).toEqual([])
          expect(observedText).toContain('Packaged server ')
          expect(observedText).toContain('Packaged server reply.')
          expect([...items.values()].find((row) => row.body?.kind === 'turn')?.body).toMatchObject({
            state: 'completed',
            outcome: 'success'
          })
        },
        { timeout: 15_000 }
      )
      const report = ChildReport.parse(JSON.parse(readFileSync(reportPath, 'utf8')))
      expect(report.argv[0]).toBe(script)
      expect(report.argv).toEqual(
        expect.arrayContaining([
          '--input-format',
          'stream-json',
          '--output-format',
          '--include-partial-messages',
          '--replay-user-messages',
          '--permission-prompt-tool',
          'stdio',
          `--session-id=${claudeSessionIdForOrcaSession(sessionId)}`,
          '--setting-sources=user,project,local',
          '--dangerously-skip-permissions'
        ])
      )
      expect(report.execPath).toBe(runtime)
      expect(report.cwd).toBe(home)
      expect(report.env).toMatchObject({
        HOME: home,
        ORCA_AGENT_SESSION_ID: sessionId,
        ORCA_STRUCTURED_SESSION: '1',
        ORCA_USER_DATA_PATH: userData,
        ORCA_SDK_CONTRACT_SCENARIO_PATH: scenarioPath,
        ORCA_SDK_CONTRACT_REPORT_PATH: reportPath
      })
      expect(report.env.CLAUDE_CONFIG_DIR).toBe(join(home, 'claude-config'))
      expect(report.env).not.toHaveProperty('ORCA_PANE_KEY')
      expect(report.userMessages).toHaveLength(1)
      expect(report.userMessages[0]?.message.content).toEqual([
        { type: 'text', text: 'Hello packaged server' }
      ])
      // Follow-up #26464: assert ORCA_CLI_COMMAND executes the packaged host CLI.
    } finally {
      subscription?.close()
      await killChildAndWait(server.child)
    }
  }, 90_000)
})
