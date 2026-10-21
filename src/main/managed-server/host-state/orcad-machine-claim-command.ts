import { randomUUID } from 'node:crypto'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { RELAY_REMOTE_DIR } from '../../ssh/remote-exec/remote-frame-protocol'
import {
  ORCAD_MACHINE_CLAIM_FILENAME,
  ORCAD_MACHINE_CLAIM_SCHEMA_VERSION,
  parseOrcadMachineClaim
} from './orcad-machine-home'
import { dfAvailableKb } from './remote-filesystem-space'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

/** Under `~/.orca-remote`: decides the claim when hard links cannot (see the claim command). */
export const ORCAD_MACHINE_CLAIM_ARBITER_DIRNAME = 'orcad-machine.arbiter'

/** A claim step failed; the line carries the step and the shell's own error text. */
export const ORCAD_MACHINE_CLAIM_FAILED = 'CLAIM_FAILED'
/** The `df -Pk` line for `~/.orca-remote`, printed after a failure. */
export const ORCAD_MACHINE_CLAIM_SPACE = 'CLAIM_SPACE'

const CLAIM_STEP_TEXT = {
  mkdir: (base: string) => `could not create ${base}`,
  write: (base: string) => `could not write a claim file in ${base}`,
  'arbiter-write': (base: string) => `could not write the claim arbiter in ${base}`,
  'arbiter-empty': (base: string) => `the claim arbiter in ${base} holds no claim`,
  publish: (_base: string, claim: string) => `could not move the claim into place at ${claim}`,
  read: (_base: string, claim: string) => `could not read ${claim} back`,
  empty: (_base: string, claim: string) => `${claim} was empty right after it was written`
}

type OrcadMachineClaimStep = keyof typeof CLAIM_STEP_TEXT

function isClaimStep(step: string | undefined): step is OrcadMachineClaimStep {
  return step !== undefined && Object.hasOwn(CLAIM_STEP_TEXT, step)
}

/** Below this, a failed write on the claim's filesystem reads as a full disk or spent quota. */
const NEARLY_FULL_KB = 1024

/**
 * Publishes the claim exclusively and prints whichever claim won. Why a hard link: `ln` is atomic
 * and exclusive on NFS too, and a reader never sees a half-written claim. Where `ln` cannot decide
 * (no hard links, or an empty claim a full disk left), a directory rename picks the winner: it is
 * atomic everywhere, and the arbiter arrives already holding the winner's claim, so a crash leaves
 * no half-taken lock. Every machine then republishes that same claim, so concurrent writes agree.
 * A failed step prints `CLAIM_FAILED <step> <error>` and exits 0, so the user reads why (#30491).
 */
export function orcadMachineClaimCommand(
  host: RemoteHostPlatform,
  loginHome: string,
  machineKey: string
): string {
  const remoteDir = (...parts: string[]): string =>
    quotePosixShell(joinRemotePath(host, loginHome, RELAY_REMOTE_DIR, ...parts))
  const attempt = randomUUID()
  const base = remoteDir()
  const claim = remoteDir(ORCAD_MACHINE_CLAIM_FILENAME)
  const partial = remoteDir(`${ORCAD_MACHINE_CLAIM_FILENAME}.partial.${attempt}`)
  const stageName = `${ORCAD_MACHINE_CLAIM_ARBITER_DIRNAME}.partial.${attempt}`
  const stage = remoteDir(stageName)
  const stageClaim = remoteDir(stageName, ORCAD_MACHINE_CLAIM_FILENAME)
  const arbiter = remoteDir(ORCAD_MACHINE_CLAIM_ARBITER_DIRNAME)
  const arbiterClaim = remoteDir(ORCAD_MACHINE_CLAIM_ARBITER_DIRNAME, ORCAD_MACHINE_CLAIM_FILENAME)
  // `mv` into an existing arbiter nests the stage inside it instead of replacing it.
  const nestedStage = remoteDir(ORCAD_MACHINE_CLAIM_ARBITER_DIRNAME, stageName)
  const body = quotePosixShell(
    JSON.stringify({
      schemaVersion: ORCAD_MACHINE_CLAIM_SCHEMA_VERSION,
      machineKey
    })
  )
  const fail = (step: OrcadMachineClaimStep, detail = ''): string =>
    `orca_claim_fail ${step} ${detail || "''"}`
  return [
    `orca_claim_fail() { printf '${ORCAD_MACHINE_CLAIM_FAILED} %s %s\\n' "$1" "$(printf %s "$2" | tr '\\n' ' ' | cut -c 1-300)";`,
    `rm -f ${partial}; df -Pk ${base} 2>/dev/null | tail -n 1 | sed 's/^/${ORCAD_MACHINE_CLAIM_SPACE} /'; exit 0; };`,
    `umask 077; err=$(mkdir -p ${base} 2>&1) || ${fail('mkdir', '"$err"')};`,
    // `[ -s ]` too: a network filesystem can report a dropped write only at close, which `>` ignores.
    `err=$(printf %s ${body} 2>&1 > ${partial}) && [ -s ${partial} ] || ${fail('write', '"$err"')};`,
    // Once an arbiter exists it decides any claim that later goes missing or empty.
    `if { [ -d ${arbiter} ] || ! ln ${partial} ${claim} 2>/dev/null; } && [ ! -s ${claim} ]; then`,
    `err=$( { mkdir ${stage} && printf %s ${body} > ${stageClaim}; } 2>&1 ) || { rm -rf ${stage}; ${fail('arbiter-write', '"$err"')}; };`,
    `mv ${stage} ${arbiter} 2>/dev/null; rm -rf ${stage} ${nestedStage};`,
    `[ -s ${arbiterClaim} ] || ${fail('arbiter-empty')};`,
    `err=$(cat ${arbiterClaim} 2>&1 > ${partial}) || ${fail('write', '"$err"')};`,
    `if [ ! -s ${claim} ]; then err=$(mv -f ${partial} ${claim} 2>&1) || ${fail('publish', '"$err"')}; fi;`,
    // Stderr only on failure: a warning glued to the claim (which has no newline) would hide it.
    `fi; rm -f ${partial}; claim=$(cat ${claim} 2>/dev/null) || { err=$(cat ${claim} 2>&1 >/dev/null); ${fail('read', '"$err"')}; };`,
    `[ -n "$claim" ] || ${fail('empty')}; printf '%s\\n' "$claim"`
  ].join(' ')
}

/** What the claim command printed: the winning claim, or the error the user should read. */
export function readOrcadMachineClaimAnswer(
  output: string
): { state: 'present'; machineKey: string } | { state: 'failed'; message: string } {
  const lines = output.split('\n').map((line) => line.trim())
  const failed = lines.find((line) => line.startsWith(`${ORCAD_MACHINE_CLAIM_FAILED} `))
  const base = `~/${RELAY_REMOTE_DIR}`
  const claim = `${base}/${ORCAD_MACHINE_CLAIM_FILENAME}`
  if (!failed) {
    // Line by line: a gateway that merges stderr into stdout can put shell noise beside it (#30491).
    for (const line of lines.toReversed()) {
      const read = parseOrcadMachineClaim(line)
      if (read.state === 'present') {
        return read
      }
    }
    return claimFailure(`${claim} did not hold a claim after it was written`, null, base)
  }
  const [, step, ...detail] = failed.split(' ')
  const text = isClaimStep(step)
    ? CLAIM_STEP_TEXT[step](base, claim)
    : `failed at ${step ?? 'an unknown step'}`
  const error = detail.join(' ').trim()
  const space = lines.find((line) => line.startsWith(`${ORCAD_MACHINE_CLAIM_SPACE} `))
  return claimFailure(
    error ? `${text}: ${error}` : text,
    dfAvailableKb(space?.slice(ORCAD_MACHINE_CLAIM_SPACE.length)),
    base
  )
}

function claimFailure(
  what: string,
  availableKb: number | null,
  base: string
): { state: 'failed'; message: string } {
  const advice =
    availableKb !== null && availableKb < NEARLY_FULL_KB
      ? `The filesystem holding ${base} has ${availableKb} KB free: free space there (or raise ` +
        'the quota), then reconnect.'
      : `Check that ${base} belongs to this user and is writable, and that its filesystem (an ` +
        'NFS or other network home included) is mounted read-write and not over quota, then ' +
        'reconnect.'
  return {
    state: 'failed',
    message: `orcad could not claim this host's ${RELAY_REMOTE_DIR}: ${what}. ${advice}`
  }
}
