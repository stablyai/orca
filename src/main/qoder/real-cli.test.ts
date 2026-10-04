import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { normalizeAndAccept } from '../../shared/agent-hook-listener-test-harness'
import { parseQoderSessionFile } from '../ai-vault/session-scanner-qoder-parser'

const sandbox = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof Os>()
  return { ...original, homedir: () => sandbox.home || original.homedir() }
})
vi.mock('electron', () => ({ app: { getPath: () => sandbox.home } }))
import { qoderHookService } from './hook-service'
import { markQoderWorkspaceTrusted } from './workspace-trust'

it.skipIf(process.env.ORCA_REAL_QODER_CLI_TEST !== '1')(
  'generates and resumes a real task through managed hooks',
  async () => {
    const realHome = homedir()
    sandbox.home = await realpath(await mkdtemp(join(tmpdir(), 'orca-qoder-real-')))
    const config = join(sandbox.home, '.qoder')
    const workspace = join(sandbox.home, 'folder')
    const statuses: {
      event: unknown
      state: unknown
      agent: unknown
      session: string | undefined
    }[] = []
    const listener = createHookListenerState()
    const server = createServer(async (request, response) => {
      let content = ''
      for await (const chunk of request) {
        content += chunk
      }
      const fields = new URLSearchParams(content)
      const payload = JSON.parse(fields.get('payload') ?? '{}')
      const normalized = normalizeAndAccept(listener, 'qoder', payload)
      statuses.push({
        event: payload.hook_event_name,
        state: normalized?.payload.state,
        agent: normalized?.payload.agentType,
        session: normalized?.providerSession?.id
      })
      response.writeHead(request.url === '/hook/qoder' ? 200 : 404).end()
    })
    try {
      await mkdir(workspace)
      await mkdir(config)
      await cp(join(realHome, '.qoder', '.auth'), join(config, '.auth'), { recursive: true })
      await writeFile(
        join(config, 'settings.json'),
        JSON.stringify({ general: { enableAutoUpdate: false } })
      )
      expect(qoderHookService.install().state).toBe('installed')
      markQoderWorkspaceTrusted(workspace, sandbox.home)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('No test receiver port')
      }
      const env = {
        ...process.env,
        HOME: sandbox.home,
        USERPROFILE: sandbox.home,
        ORCA_AGENT_HOOK_PORT: String(address.port),
        ORCA_AGENT_HOOK_TOKEN: 'test-token',
        ORCA_PANE_KEY: 'qoder-proof-pane',
        ORCA_AGENT_HOOK_ENDPOINT: '',
        ORCA_AGENT_HOOK_TRANSPORT: '',
        ORCA_BACKGROUND_LAUNCH: '1'
      }
      const command = process.env.ORCA_QODER_CLI_PATH ?? join(realHome, '.local', 'bin', 'qodercli')
      const args = [
        '--config-dir',
        config,
        '--cwd',
        workspace,
        '--max-model-request-retries',
        '0',
        '--print'
      ]
      const generated = await runProcess({
        program: command,
        args: [
          ...args,
          '--permission-mode',
          'accept_edits',
          'Create proof.txt containing exactly QODER_MANAGED_PROOF. Then reply QODER_MANAGED_COMPLETE.'
        ],
        env,
        timeoutMs: 90000
      })
      expect(generated.code).toBe(0)
      expect((await readFile(join(workspace, 'proof.txt'), 'utf8')).trim()).toBe(
        'QODER_MANAGED_PROOF'
      )
      const session = statuses.find((s) => s.event === 'SessionStart')?.session
      expect(session).toBeTruthy()
      if (!session) {
        throw new Error('Qoder did not identify its session')
      }
      const resumed = await runProcess({
        program: command,
        args: [
          ...args,
          '--resume',
          session,
          'What exact marker did you write? Reply only with that marker.'
        ],
        env,
        timeoutMs: 90000
      })
      expect(resumed.code).toBe(0)
      expect(resumed.stdout.trim()).toBe('QODER_MANAGED_PROOF')
      const projects = join(config, 'projects')
      const transcript = (await readdir(projects, { recursive: true })).find(
        (path) => path.endsWith(`${session}.jsonl`) && !path.includes('subagents')
      )
      if (!transcript) {
        throw new Error('Qoder did not persist the generated and resumed session')
      }
      const path = join(projects, transcript)
      const modified = await stat(path)
      const history = await parseQoderSessionFile({
        path,
        mtimeMs: modified.mtimeMs,
        modifiedAt: modified.mtime.toISOString()
      })
      expect(history).toMatchObject({ agent: 'qoder', sessionId: session, cwd: workspace })
      expect(history?.previewMessages.at(-1)?.text).toBe('QODER_MANAGED_PROOF')
      expect(history?.resumeCommand).toContain(`qodercli --resume '${session}'`)
      expect(statuses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'SessionStart',
            state: 'done',
            agent: 'qoder',
            session
          }),
          expect.objectContaining({ event: 'UserPromptSubmit', state: 'working', agent: 'qoder' }),
          expect.objectContaining({ event: 'Stop', state: 'done', agent: 'qoder' })
        ])
      )
      const evidencePath = process.env.ORCA_QODER_PROOF_PATH
      if (evidencePath) {
        await writeFile(
          evidencePath,
          JSON.stringify(
            {
              generated: generated.stdout.trim(),
              resumed: resumed.stdout.trim(),
              statuses,
              history: {
                agent: history?.agent,
                sessionId: history?.sessionId,
                lastReply: history?.previewMessages.at(-1)?.text,
                resumeVerified: true
              }
            },
            null,
            2
          )
        )
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(sandbox.home, { recursive: true, force: true })
      sandbox.home = ''
    }
  },
  180000
)
