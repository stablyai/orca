import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as mobilePhase from './run-typecheck-projects-in-parallel.mjs'
import { OXLINT_SCANS, parseCodeQualityOptions } from './check-changed-code-quality.mjs'
import {
  partitionMobileJoinedFiles,
  runMobileJoinedOxlintScan
} from './mobile-joined-code-quality.mjs'

describe('Mobile joined analyzer routing', () => {
  const root = path.resolve(import.meta.dirname, '../..')
  const scan = OXLINT_SCANS.find((entry) => entry.label === 'type-aware code quality')
  const roots = JSON.parse(readFileSync(path.join(root, mobilePhase.MOBILE_JOINED_PROJECT), 'utf8'))
    .files.filter((file) => /\.test\.tsx?$/.test(file))
    .map((file) =>
      path
        .relative(root, path.resolve(root, 'config', file))
        .split(path.sep)
        .join('/')
    )
  afterEach(() => vi.restoreAllMocks())

  it('keeps opt-in separate from base and partitions the exact configured roots without losing targets', () => {
    expect(parseCodeQualityOptions(['base', '--mobile-host-declarations'])).toEqual({
      requestedBase: 'base',
      mobileHostDeclarations: true
    })
    expect(parseCodeQualityOptions(['--mobile-host-declarations', 'base']).requestedBase).toBe(
      'base'
    )
    expect(parseCodeQualityOptions(['base']).mobileHostDeclarations).toBe(false)
    expect(() => parseCodeQualityOptions(['base', '--typo'])).toThrow()
    expect(partitionMobileJoinedFiles(root, [roots[0], 'src/ordinary.ts', roots[2]])).toEqual({
      joined: [roots[0], roots[2]],
      rest: ['src/ordinary.ts']
    })
    expect(partitionMobileJoinedFiles(root, ['src/ordinary.ts']).joined).toEqual([])
  })

  function phaseResult(result) {
    const execute = vi.fn(async () => result)
    vi.spyOn(mobilePhase, 'selectTypecheckCompiler').mockReturnValue({
      compiler: 'bun',
      bunExecutable: 'fixture-bun'
    })
    const phase = vi
      .spyOn(mobilePhase, 'runMobileHostTypecheck')
      .mockImplementation(async (options) => {
        await options.consumeDeclarations({
          signal: new AbortController().signal,
          runOwnedProcess: execute
        })
        return []
      })
    return { execute, phase }
  }

  it('captures legitimate nonzero diagnostics using the exact generated override after both checks', async () => {
    const diagnostics = [
      { filename: roots[0], message: 'actual finding', labels: [{ span: { line: 1 } }] }
    ]
    const { phase, execute } = phaseResult({
      code: 1,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify({ diagnostics }),
      stderr: ''
    })
    expect(await runMobileJoinedOxlintScan(root, scan, [roots[0]])).toEqual(diagnostics)
    expect(phase.mock.calls[0][0]).toMatchObject({ compiler: 'bun', bunThreads: 2 })
    expect(phase.mock.calls[0][0].projects.map((project) => project.config)).toEqual([
      'mobile/tsconfig.json',
      mobilePhase.MOBILE_JOINED_PROJECT
    ])
    const command = execute.mock.calls[0][0]
    expect(command.args.slice(-6)).toEqual([
      '--type-check',
      '--tsconfig',
      mobilePhase.MOBILE_JOINED_PROJECT,
      '--format',
      'json',
      roots[0]
    ])
    expect(command.args).toContain('--tsconfig')
    expect(command).toMatchObject({
      stdio: 'pipe',
      maxOutputBytes: 128 * 1024 * 1024,
      killOnOutputLimit: true
    })
  })

  it('never treats missing, malformed, truncated or signalled output as zero findings', async () => {
    const good = {
      code: 0,
      signal: null,
      timedOut: false,
      stdout: '{"diagnostics":[]}',
      stderr: ''
    }
    const { execute } = phaseResult(good)
    for (const result of [
      { ...good, stdout: '' },
      { ...good, stdout: '{"diagnostics":[' },
      { ...good, stdout: '{}' },
      { ...good, outputTruncated: true },
      { ...good, signal: 'SIGTERM' },
      { ...good, timedOut: true },
      { ...good, code: 1 }
    ]) {
      execute.mockResolvedValue(result)
      await expect(runMobileJoinedOxlintScan(root, scan, [roots[0]])).rejects.toThrow()
    }
    await expect(runMobileJoinedOxlintScan(root, scan, [])).rejects.toThrow('literal')
  })

  it('keeps a missing required phase or compiler failure an infrastructure failure', async () => {
    phaseResult({
      code: 0,
      signal: null,
      timedOut: false,
      stdout: '{"diagnostics":[]}',
      stderr: ''
    })
    mobilePhase.runMobileHostTypecheck.mockResolvedValue([new Error('required check failed')])
    await expect(runMobileJoinedOxlintScan(root, scan, [roots[0]])).rejects.toThrow(
      'infrastructure failed'
    )
    mobilePhase.runMobileHostTypecheck.mockResolvedValue([])
    await expect(runMobileJoinedOxlintScan(root, scan, [roots[0]])).rejects.toThrow('not completed')
  })
})
