import { describe, expect, it, vi } from 'vitest'
import type { SkillUpdateRun } from '../../shared/skill-freshness'
import type { SkillInstallResult } from '../../shared/skill-install-contract'
import { SkillUpdateRunner } from './skill-update-run'

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (e: Error) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function result(
  name: string,
  status: SkillInstallResult['status'],
  extra: Partial<SkillInstallResult> = {}
): SkillInstallResult {
  return {
    operationId: 'op',
    status,
    name,
    packageDigest: 'a'.repeat(64),
    canonicalPath: `/home/u/.agents/skills/${name}`,
    placements: [],
    ...extra
  }
}

function makeRunner(rescanOutdatedNames?: (names: string[]) => Promise<string[]>) {
  const installs: { names: string[]; signal: AbortSignal; done: Deferred<SkillInstallResult[]> }[] =
    []
  const states: SkillUpdateRun[] = []
  const runner = new SkillUpdateRunner({
    installSkills: (names, signal) => {
      const done = deferred<SkillInstallResult[]>()
      installs.push({ names, signal, done })
      return done.promise
    },
    rescanOutdatedNames,
    now: () => 1000,
    onState: (run) => states.push(run)
  })
  return { runner, installs, states }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('SkillUpdateRunner', () => {
  it('installs the sorted, de-duplicated names', () => {
    const { runner, installs, states } = makeRunner()

    expect(runner.start(['orchestration', 'orca-cli', 'orca-cli'])).toEqual({ started: true })
    expect(installs[0].names).toEqual(['orca-cli', 'orchestration'])
    expect(states.at(-1)).toMatchObject({ state: 'running', names: ['orca-cli', 'orchestration'] })
  })

  it('rejects names that are not skill names', () => {
    const { runner, installs } = makeRunner()
    expect(runner.start(['orca-cli; rm -rf ~'])).toEqual({
      started: false,
      reason: 'invalid-names'
    })
    expect(installs).toHaveLength(0)
  })

  it('refuses a second concurrent run', () => {
    const { runner } = makeRunner()
    runner.start(['orca-cli'])
    expect(runner.start(['orca-cli'])).toEqual({ started: false, reason: 'already-running' })
  })

  it('reports each skill in the log and succeeds when every copy landed', async () => {
    const { runner, installs } = makeRunner(async () => [])
    runner.start(['orca-cli', 'orchestration'])
    installs[0].done.resolve([result('orca-cli', 'updated'), result('orchestration', 'unchanged')])
    await flush()

    expect(runner.getState()).toEqual({
      state: 'success',
      names: ['orca-cli', 'orchestration'],
      finishedAt: 1000,
      output:
        'orca-cli: updated (/home/u/.agents/skills/orca-cli)\n' +
        'orchestration: already up to date (/home/u/.agents/skills/orchestration)'
    })
  })

  it('names a locally edited copy in the log and fails it', async () => {
    const { runner, installs } = makeRunner(async () => ['orca-cli'])
    runner.start(['orca-cli'])
    installs[0].done.resolve([
      result('orca-cli', 'conflict', { conflict: { kind: 'modified' }, canonicalPath: undefined })
    ])
    await flush()

    expect(runner.getState()).toMatchObject({
      state: 'error',
      failedNames: ['orca-cli'],
      message: 'Some skills could not be updated.',
      output: 'orca-cli: not changed, the installed copy has changes Orca did not make'
    })
  })

  it('trusts the re-scan over the install results', async () => {
    const { runner, installs } = makeRunner(async () => [])
    runner.start(['orca-cli'])
    installs[0].done.resolve([result('orca-cli', 'partial')])
    await flush()
    expect(runner.getState().state).toBe('success')
  })

  it('falls back to the install results when the re-scan fails', async () => {
    const { runner, installs } = makeRunner(async () => {
      throw new Error('scan failed')
    })
    runner.start(['orca-cli', 'orchestration'])
    installs[0].done.resolve([result('orca-cli', 'updated'), result('orchestration', 'failed')])
    await flush()
    expect(runner.getState()).toMatchObject({ state: 'error', failedNames: ['orchestration'] })
  })

  it('fails every name when the install itself throws', async () => {
    const { runner, installs } = makeRunner()
    runner.start(['orca-cli', 'orchestration'])
    installs[0].done.reject(new Error('Skill installs are unavailable in this process.'))
    await flush()
    expect(runner.getState()).toMatchObject({
      state: 'error',
      failedNames: ['orca-cli', 'orchestration'],
      output: 'Skill installs are unavailable in this process.'
    })
  })

  it('stays running after Stop until the install settles, re-scans, then goes idle', async () => {
    const rescan = vi.fn(async () => [])
    const { runner, installs } = makeRunner(rescan)
    runner.start(['orca-cli'])
    runner.cancel()

    expect(installs[0].signal.aborted).toBe(true)
    expect(runner.getState()).toMatchObject({ state: 'running', stopping: true })
    expect(runner.start(['orca-cli'])).toEqual({ started: false, reason: 'already-running' })

    installs[0].done.resolve([result('orca-cli', 'cancelled')])
    await flush()
    expect(rescan).toHaveBeenCalledWith(['orca-cli'])
    expect(runner.getState()).toEqual({ state: 'idle' })
    expect(runner.start(['orca-cli'])).toEqual({ started: true })
  })

  it('stays live while its re-scan is still reading disk', async () => {
    const rescan = deferred<string[]>()
    const { runner, installs } = makeRunner(() => rescan.promise)
    runner.start(['orca-cli'])
    installs[0].done.resolve([result('orca-cli', 'updated')])
    await flush()
    runner.acknowledge()
    // The first run is still re-scanning, so it has not settled and acknowledge is a no-op.
    expect(runner.getState().state).toBe('running')
    rescan.resolve([])
    await flush()
    expect(runner.getState().state).toBe('success')
  })

  it('acknowledge clears a settled run but leaves a live one alone', async () => {
    const { runner, installs } = makeRunner(async () => [])
    runner.start(['orca-cli'])
    runner.acknowledge()
    expect(runner.getState().state).toBe('running')
    installs[0].done.resolve([result('orca-cli', 'updated')])
    await flush()
    runner.acknowledge()
    expect(runner.getState()).toEqual({ state: 'idle' })
  })
})
