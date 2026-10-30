import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { requireCodexForkCutSupport } from './codex-fork-cut-support'

const runProcess = vi.hoisted(() => vi.fn())
vi.mock('@orca/process-host', () => ({ runProcess }))

const launch = {
  command: 'codex',
  args: ['--disable', 'fast_mode', 'app-server'],
  cwd: '/workspace',
  codexHome: null,
  resumeThreadId: 'parent',
  env: { CODEX_HOME: '/parent-account' }
}

describe('Codex inclusive fork support', () => {
  it('checks the exact installed binary schema before allowing a fork', async () => {
    runProcess.mockImplementationOnce(async (spec) => {
      expect(spec.args.slice(0, -1)).toEqual([
        ...launch.args,
        'generate-json-schema',
        '--experimental',
        '--out'
      ])
      expect(spec.env.CODEX_HOME).toBe('/parent-account')
      const directory = spec.args.at(-1)
      await mkdir(join(directory, 'v2'))
      await writeFile(
        join(directory, 'v2', 'ThreadForkParams.json'),
        JSON.stringify({ properties: { lastTurnId: {}, deferGoalContinuation: {} } })
      )
      return { code: 0 }
    })
    await expect(requireCodexForkCutSupport(launch)).resolves.toBeUndefined()
  })

  it('refuses older schemas and unavailable capability probes', async () => {
    runProcess.mockImplementationOnce(async (spec) => {
      const directory = spec.args.at(-1)
      await mkdir(join(directory, 'v2'))
      await writeFile(
        join(directory, 'v2', 'ThreadForkParams.json'),
        JSON.stringify({ properties: { threadId: {} } })
      )
      return { code: 0 }
    })
    await expect(requireCodexForkCutSupport(launch)).rejects.toThrow('Update Codex')
    runProcess.mockResolvedValueOnce({ code: 1 })
    await expect(requireCodexForkCutSupport(launch)).rejects.toThrow('Update Codex')
  })
})
