import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { buildOmpRpcLaunch, resolveOmpRpcResume } from './rpc-launch'

it('preserves command prefix arguments before selecting RPC UI mode', () => {
  const script = join('installed agents', 'omp.js')
  const sessionFile = join('sessions', 'chat.jsonl')
  const launch = buildOmpRpcLaunch({
    command: process.execPath,
    prefixArgs: [script],
    cwd: process.cwd(),
    fullAccess: true,
    sessionFile,
    extraArgs: ['--thinking', 'low']
  })
  expect(launch.command).toBe(process.execPath)
  expect(launch.args).toEqual([
    script,
    '--mode',
    'rpc-ui',
    '--thinking',
    'low',
    '--session',
    sessionFile
  ])
})

it('resolves a legacy ACP OMP handle to its JSONL session for RPC resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-rpc-resume-'))
  const cwd = join(root, 'workspace')
  const sessionId = '01a00000-0000-7000-8000-000000000001'
  const sessions = join(root, 'agent', 'sessions', '-workspace')
  const sessionFile = join(sessions, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`)
  await mkdir(sessions, { recursive: true })
  await mkdir(cwd, { recursive: true })
  await writeFile(
    sessionFile,
    `${JSON.stringify({ type: 'title', v: 1, title: 'legacy' })}\n${JSON.stringify({
      type: 'session',
      version: 3,
      id: sessionId,
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd
    })}\n`
  )

  const resolved = await resolveOmpRpcResume({
    previous: {
      linkId: 'legacy',
      handle: { transport: 'acp', agent: 'omp', nativeId: sessionId },
      origin: 'created',
      mintedAtFence: 1,
      observedAt: 1
    },
    cwd,
    env: { USERPROFILE: root, PI_CODING_AGENT_DIR: join(root, 'agent') },
    priorLineage: [sessionId]
  })

  expect(resolved.sessionFile).toBe(sessionFile)
  expect(resolved.lineage).toEqual([sessionId, sessionFile])
})

it('rejects a legacy ACP handle when its transcript is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-rpc-resume-missing-'))
  await expect(
    resolveOmpRpcResume({
      previous: {
        linkId: 'legacy',
        handle: {
          transport: 'acp',
          agent: 'omp',
          nativeId: '01a00000-0000-7000-8000-000000000002'
        },
        origin: 'created',
        mintedAtFence: 1,
        observedAt: 1
      },
      cwd: join(root, 'workspace'),
      env: { USERPROFILE: root, PI_CODING_AGENT_DIR: join(root, 'agent') }
    })
  ).rejects.toThrow('OMP ACP session transcript is missing')
})
