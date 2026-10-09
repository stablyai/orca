import { describe, expect, it, vi } from 'vitest'
import {
  dumpHarmonyAccessibilityTree,
  installHapArgs,
  installHarmonyHap,
  launchAbilityArgs,
  launchHarmonyApp,
  parseLayoutPath
} from './harmony-capability-operations'
import type { HarmonyCommandRunner } from './harmony-command-runner'
import type { HarmonySdkPaths } from './harmony-sdk-discovery'

const SDK: HarmonySdkPaths = {
  sdkRoot: '/sdk',
  hdc: '/sdk/hdc',
  emulator: '/sdk/Emulator'
}

const KEY = '127.0.0.1:5555'

describe('installHapArgs', () => {
  it('builds install args without and with -r', () => {
    expect(installHapArgs(KEY, '/tmp/app.hap')).toEqual(['-t', KEY, 'install', '/tmp/app.hap'])
    expect(installHapArgs(KEY, '/tmp/app.hap', { reinstall: true })).toEqual([
      '-t',
      KEY,
      'install',
      '-r',
      '/tmp/app.hap'
    ])
  })
})

describe('installHarmonyHap', () => {
  it('resolves on success output', async () => {
    const run: HarmonyCommandRunner = async () => ({
      stdout: 'install bundle successfully',
      stderr: '',
      code: 0
    })
    await installHarmonyHap(run, SDK, KEY, '/tmp/app.hap')
  })

  it('throws on non-zero exit', async () => {
    const run: HarmonyCommandRunner = async () => ({ stdout: '', stderr: 'no space', code: 1 })
    await expect(installHarmonyHap(run, SDK, KEY, '/tmp/app.hap')).rejects.toThrow(
      'hdc install failed: no space'
    )
  })

  it('throws when an error message appears at exit 0', async () => {
    const run: HarmonyCommandRunner = async () => ({
      stdout: 'error: incompatible device',
      stderr: '',
      code: 0
    })
    await expect(installHarmonyHap(run, SDK, KEY, '/tmp/app.hap')).rejects.toThrow(
      'hdc install failed: error: incompatible device'
    )
  })
})

describe('launchAbilityArgs', () => {
  it('defaults to EntryAbility', () => {
    expect(launchAbilityArgs(KEY, 'com.acme.app')).toEqual([
      '-t',
      KEY,
      'shell',
      'aa',
      'start',
      '-b',
      'com.acme.app',
      '-a',
      'EntryAbility'
    ])
  })

  it('uses the provided ability', () => {
    expect(launchAbilityArgs(KEY, 'com.acme.app', 'OtherAbility')).toContain('OtherAbility')
  })
})

describe('launchHarmonyApp', () => {
  it('throws on aa failure', async () => {
    const run: HarmonyCommandRunner = async () => ({
      stdout: '',
      stderr: 'bundle not found',
      code: 1
    })
    await expect(launchHarmonyApp(run, SDK, KEY, 'com.acme.app')).rejects.toThrow(
      'aa start failed: bundle not found'
    )
  })
})

describe('parseLayoutPath', () => {
  it('extracts the file path', () => {
    expect(parseLayoutPath('DumpLayout saved to:/data/local/tmp/layout_1.json')).toBe(
      '/data/local/tmp/layout_1.json'
    )
    expect(parseLayoutPath('no path')).toBeNull()
  })
})

describe('dumpHarmonyAccessibilityTree', () => {
  const layoutTree = {
    attributes: { type: 'PhoneWindow', bounds: '[0,0][100,200]' },
    children: []
  }

  function runnerFor(calls: { layoutFile?: string }): HarmonyCommandRunner {
    return vi.fn<HarmonyCommandRunner>(async (_binary, args) => {
      const command = args.join(' ')
      if (command.includes('dumpLayout')) {
        return {
          stdout: `DumpLayout saved to:${calls.layoutFile ?? '/data/local/tmp/layout_1.json'}`,
          stderr: '',
          code: 0
        }
      }
      if (command.includes('file recv')) {
        return { stdout: '', stderr: '', code: 0 }
      }
      return { stdout: '', stderr: '', code: 0 }
    })
  }

  it('dumps, pulls, parses and normalizes', async () => {
    // The pulled file is read from disk; intercept via the runner's known path.
    const localRead = vi.spyOn(await import('node:fs/promises'), 'readFile')
    localRead.mockResolvedValue(JSON.stringify(layoutTree))

    const run = runnerFor({})
    const tree = await dumpHarmonyAccessibilityTree(run, SDK, KEY)
    expect(tree).toHaveLength(1)
    expect(tree[0]?.type).toBe('PhoneWindow')
    localRead.mockRestore()
  })

  it('throws when dumpLayout reports no path', async () => {
    const run = vi.fn<HarmonyCommandRunner>(async () => ({
      stdout: 'failure',
      stderr: '',
      code: 0
    }))
    await expect(dumpHarmonyAccessibilityTree(run, SDK, KEY)).rejects.toThrow(
      'uitest dumpLayout did not report a file path.'
    )
  })
})
