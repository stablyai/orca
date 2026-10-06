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
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { makePaneKey } from '../../shared/stable-pane-id'
import { parseQoderSessionFile } from '../ai-vault/session-scanner-qoder-parser'

const sandbox = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof Os>()
  return { ...original, homedir: () => sandbox.home || original.homedir() }
})
vi.mock('electron', () => ({ app: { getPath: () => sandbox.home } }))
import { qoderHookService } from './hook-service'
import { markQoderWorkspaceTrusted } from './workspace-trust'
import { AgentHookServer } from '../agent-hooks/server'

it.skipIf(process.env.ORCA_REAL_QODER_CLI_TEST !== '1')(
  'generates and resumes a real task through managed hooks',
  async () => {
    const realHome = homedir()
    sandbox.home = await realpath(await mkdtemp(join(tmpdir(), 'orca-qoder-real-')))
    const config = join(sandbox.home, '.qoder')
    const workspace = join(sandbox.home, 'folder')
    const proofFile = `qoder-proof-${randomUUID()}.txt`
    const marker = `QODER_MANAGED_PROOF_${randomUUID()}`
    const statuses: {
      event: unknown
      state: unknown
      agent: unknown
      session: string | undefined
    }[] = []
    const server = new AgentHookServer()
    server.subscribeEnrichedStatus((normalized) => {
      statuses.push({
        event: normalized.hookEventName,
        state: normalized.payload.state,
        agent: normalized.payload.agentType,
        session: normalized.providerSession?.id
      })
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
      await server.start({ env: 'production', userDataPath: join(sandbox.home, 'orca') })
      const env = {
        ...process.env,
        HOME: sandbox.home,
        USERPROFILE: sandbox.home,
        ...server.buildPtyEnv(),
        ORCA_PANE_KEY: makePaneKey(randomUUID(), randomUUID()),
        ORCA_BACKGROUND_LAUNCH: '1'
      }
      const command = process.env.ORCA_QODER_CLI_PATH ?? join(realHome, '.local', 'bin', 'qodercli')
      const version = await runProcess({ program: command, args: ['--version'], env })
      expect(version.code).toBe(0)
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
          `Create ${proofFile} containing exactly ${marker}. Then reply QODER_MANAGED_COMPLETE.`
        ],
        env,
        timeoutMs: 90000
      })
      expect(generated.code).toBe(0)
      expect(generated.stdout.trim()).toBe('QODER_MANAGED_COMPLETE')
      expect((await readFile(join(workspace, proofFile), 'utf8')).trim()).toBe(marker)
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
          '--permission-mode',
          'accept_edits',
          `Recall the exact marker you wrote earlier without reading any file. Create resumed.txt containing that marker followed by a newline and QODER_RESUMED_CHANGE. Reply only with the original marker.`
        ],
        env,
        timeoutMs: 90000
      })
      expect(resumed.code).toBe(0)
      expect(resumed.stdout.trim()).toBe(marker)
      expect((await readFile(join(workspace, 'resumed.txt'), 'utf8')).trim()).toBe(
        `${marker}\nQODER_RESUMED_CHANGE`
      )
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
      expect(history?.previewMessages.at(-1)?.text).toBe(marker)
      expect(history?.resumeCommand).toContain(`qodercli --resume '${session}'`)
      expect(server.getStatusSnapshot()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            agentType: 'qoder',
            state: 'done',
            providerSession: expect.objectContaining({ id: session })
          })
        ])
      )
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
              command,
              version: version.stdout.trim(),
              proofFile,
              marker,
              generatedExitCode: generated.code,
              resumedExitCode: resumed.code,
              generated: generated.stdout.trim(),
              resumed: resumed.stdout.trim(),
              statuses,
              canonicalSnapshot: server.getStatusSnapshot().map((row) => ({
                agent: row.agentType,
                state: row.state,
                session: row.providerSession?.id
              })),
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
      server.stop()
      await rm(sandbox.home, { recursive: true, force: true })
      sandbox.home = ''
    }
  },
  180000
)
