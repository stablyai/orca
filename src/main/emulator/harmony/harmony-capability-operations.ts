import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { EmulatorError } from '../emulator-errors'
import type { HarmonyCommandRunner } from './harmony-command-runner'
import type { HarmonySdkPaths } from './harmony-sdk-discovery'
import { ensureHarmonyOk } from './harmony-command-result'
import { hdcTargetArgs } from './hdc-targets'
import { normalizeHarmonyAxTree } from './harmony-ax-normalization'
import type { NormalizedAxNode } from '../serve-sim-ax-normalization'

// Args for `hdc install [-r] <hap>`.
export function installHapArgs(
  connectKey: string,
  hapPath: string,
  options?: { reinstall?: boolean }
): string[] {
  return hdcTargetArgs(connectKey, ['install', ...(options?.reinstall ? ['-r'] : []), hapPath])
}

export async function installHarmonyHap(
  runner: HarmonyCommandRunner,
  sdk: HarmonySdkPaths,
  connectKey: string,
  hapPath: string,
  options?: { reinstall?: boolean }
): Promise<void> {
  const result = await runner(sdk.hdc, installHapArgs(connectKey, hapPath, options))
  // hdc install can exit 0 while printing an error message.
  if (result.code !== 0 || /error|fail/i.test(`${result.stdout}${result.stderr}`)) {
    throw new EmulatorError(
      'emulator_error',
      `hdc install failed: ${(result.stderr || result.stdout).trim() || 'unknown error'}`
    )
  }
}

// `aa start -b <bundle> -a <ability>`; EntryAbility is the conventional default.
export function launchAbilityArgs(
  connectKey: string,
  bundleName: string,
  ability?: string
): string[] {
  return hdcTargetArgs(connectKey, [
    'shell',
    'aa',
    'start',
    '-b',
    bundleName,
    '-a',
    ability || 'EntryAbility'
  ])
}

export async function launchHarmonyApp(
  runner: HarmonyCommandRunner,
  sdk: HarmonySdkPaths,
  connectKey: string,
  bundleName: string,
  ability?: string
): Promise<void> {
  ensureHarmonyOk(
    await runner(sdk.hdc, launchAbilityArgs(connectKey, bundleName, ability)),
    'aa start'
  )
}

// uitest dumpLayout stdout: "DumpLayout saved to:/data/local/tmp/layout_<ts>.json".
export function parseLayoutPath(stdout: string): string | null {
  const match = /saved to:(\S+)/.exec(stdout)
  return match ? match[1] : null
}

export async function dumpHarmonyAccessibilityTree(
  runner: HarmonyCommandRunner,
  sdk: HarmonySdkPaths,
  connectKey: string
): Promise<NormalizedAxNode[]> {
  const dumped = ensureHarmonyOk(
    await runner(sdk.hdc, hdcTargetArgs(connectKey, ['shell', 'uitest', 'dumpLayout'])),
    'uitest dumpLayout'
  )
  const remotePath = parseLayoutPath(dumped.stdout)
  if (!remotePath) {
    throw new EmulatorError('emulator_error', 'uitest dumpLayout did not report a file path.')
  }

  const localPath = join(
    tmpdir(),
    `orca-harmony-layout-${connectKey.replace(/[^a-zA-Z0-9]/g, '-')}.json`
  )
  ensureHarmonyOk(
    await runner(sdk.hdc, hdcTargetArgs(connectKey, ['file', 'recv', remotePath, localPath])),
    'layout recv'
  )

  let tree: unknown
  try {
    tree = JSON.parse(await readFile(localPath, 'utf8'))
  } catch (error) {
    throw new EmulatorError(
      'emulator_error',
      `Could not read layout file: ${error instanceof Error ? error.message : 'unknown error'}`
    )
  }
  return normalizeHarmonyAxTree(tree)
}
