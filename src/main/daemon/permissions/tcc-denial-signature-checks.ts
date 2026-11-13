// Whether the live helper and its on-disk copy still carry the app's signature at a denial.

import { runProcess } from '@orca/process-host'
import type { SignatureCheck } from '../../../shared/daemon-tcc-denial-capture'

const CODESIGN = '/usr/bin/codesign'
const CODESIGN_TIMEOUT_MS = 5_000
const CODESIGN_MAX_OUTPUT_BYTES = 64 * 1024

export type HelperSignatureChecks = {
  live: SignatureCheck
  diskCopy: SignatureCheck
}

type CodesignRun = { code: number | null; timedOut: boolean; output: string } | null

/** `…/X.app/Contents/MacOS/x` → `…/X.app`; null when the path is not inside a bundle. */
export function bundlePathOf(executablePath: string | null): string | null {
  if (!executablePath) {
    return null
  }
  const index = executablePath.lastIndexOf('.app/Contents/')
  return index === -1 ? null : executablePath.slice(0, index + '.app'.length)
}

/** codesign exits 1 on a failed verify and 3 on an unmet requirement; a vanished pid proves nothing. */
export function classifyCodesignVerify(run: CodesignRun): SignatureCheck {
  if (
    !run ||
    run.timedOut ||
    /no guest with the requested attributes|No such process/i.test(run.output)
  ) {
    return 'error'
  }
  if (run.code === 0) {
    return 'pass'
  }
  return run.code === 1 || run.code === 3 ? 'fail' : 'error'
}

export function designatedRequirementOf(run: CodesignRun): string | null {
  if (!run || run.timedOut || run.code !== 0) {
    return null
  }
  return /designated => (.+)/.exec(run.output)?.[1]?.trim() ?? null
}

async function codesign(args: string[], run: typeof runProcess): Promise<CodesignRun> {
  try {
    const result = await run({
      program: CODESIGN,
      args,
      timeoutMs: CODESIGN_TIMEOUT_MS,
      maxOutputBytes: CODESIGN_MAX_OUTPUT_BYTES,
      killOnOutputLimit: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return {
      code: result.code,
      timedOut: result.timedOut,
      output: `${result.stderr}\n${result.stdout}`
    }
  } catch {
    return null
  }
}

let appRequirement: Promise<string | null> | null = null

/** The running app's designated requirement; read once per app process. */
function appDesignatedRequirement(run: typeof runProcess): Promise<string | null> {
  const appBundle = bundlePathOf(process.execPath)
  if (!appBundle) {
    return Promise.resolve(null)
  }
  appRequirement ??= codesign(['--display', '-r-', appBundle], run).then((result) => {
    const requirement = designatedRequirementOf(result)
    // Retry a failed read at the next denial instead of pinning the failure.
    if (requirement === null) {
      appRequirement = null
    }
    return requirement
  })
  return appRequirement
}

// `codesign --verify -R … +pid` fails with EINVAL whenever the requirement matches (macOS 27), so
// verify the live code dynamically and compare its designated requirement with the app's instead.
async function checkLiveHelper(helperPid: number, run: typeof runProcess): Promise<SignatureCheck> {
  const [verify, liveDisplay, expected] = await Promise.all([
    codesign(['--verify', '--strict', `+${helperPid}`], run),
    codesign(['--display', '-r-', `+${helperPid}`], run),
    appDesignatedRequirement(run)
  ])
  const verdict = classifyCodesignVerify(verify)
  if (verdict !== 'pass') {
    return verdict
  }
  const live = designatedRequirementOf(liveDisplay)
  if (!live || !expected) {
    return 'error'
  }
  return live === expected ? 'pass' : 'fail'
}

export async function checkHelperSignatures(
  helperPid: number,
  helperExecutablePath: string | null,
  run: typeof runProcess = runProcess
): Promise<HelperSignatureChecks> {
  const helperBundle = bundlePathOf(helperExecutablePath)
  const [live, diskCopy] = await Promise.all([
    checkLiveHelper(helperPid, run),
    helperBundle
      ? codesign(['--verify', '--strict', helperBundle], run).then(classifyCodesignVerify)
      : Promise.resolve<SignatureCheck>('error')
  ])
  return { live, diskCopy }
}

export function resetHelperSignatureChecksForTests(): void {
  appRequirement = null
}
