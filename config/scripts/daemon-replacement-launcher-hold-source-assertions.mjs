#!/usr/bin/env node
/**
 * Static source assertions for the launcher's hold decision.
 *
 * Split from the repro script it serves: those phases prove behaviour with real processes,
 * while these read `daemon-init.ts` to pin the one property real processes cannot reach —
 * that the decision is taken, and returns, before anything is killed. daemon-init.ts imports
 * electron, so it cannot be executed outside the app.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')

export function stripComments(source) {
  // Blanked rather than deleted so offsets and line numbers stay true to the real file.
  const blank = (text) => text.replace(/[^\n]/g, ' ')
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])(\/\/[^\n]*)/g, (_match, prefix, comment) => prefix + blank(comment))
}

/** The balanced `{...}` block starting at `braceIndex`, or null if it never closes. */
function extractBlock(source, braceIndex) {
  let depth = 0
  for (let i = braceIndex; i < source.length; i++) {
    if (source[i] === '{') {
      depth++
    } else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        return { text: source.slice(braceIndex, i + 1), start: braceIndex, end: i + 1 }
      }
    }
  }
  return null
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

function normalize(text) {
  return text.replace(/\s+/g, ' ')
}

/**
 * PHASE 3 — the launcher must hold rather than kill. daemon-init.ts imports electron, so it
 * cannot be executed here; this reads the source instead, whitespace-tolerantly, and asserts
 * the structural properties phase 2's inputs depend on.
 */
export function checkLauncherHoldsOccupiedDaemon({ log, assert }) {
  const relativePath = 'src/main/daemon/daemon-init.ts'
  const source = stripComments(readFileSync(join(repoRoot, relativePath), 'utf8'))

  // 1. holdIncumbentDaemon() returns a preserved handle in 'held' mode — it does not adopt,
  //    which a daemon too wedged to answer listSessions could never complete anyway.
  const holdDecl = source.match(/const\s+holdIncumbentDaemon\s*=\s*\([^)]*\)[^{]*\{/)
  assert(holdDecl !== null, `${relativePath} does not declare holdIncumbentDaemon()`)
  const holdBody = extractBlock(source, holdDecl.index + holdDecl[0].length - 1)
  assert(holdBody !== null, `could not parse the holdIncumbentDaemon() body in ${relativePath}`)
  assert(
    /createPreservedDaemonHandle\([^)]*'held'\s*\)/.test(normalize(holdBody.text)),
    `holdIncumbentDaemon() does not return createPreservedDaemonHandle(..., 'held'): ${normalize(holdBody.text)}`
  )
  log(
    `phase 3: ${relativePath}:${lineOf(source, holdDecl.index)} holdIncumbentDaemon() = ${normalize(holdBody.text)}`
  )

  // 2. Process-table evidence is only ever raised from an identity-verified pid — otherwise
  //    it could describe a recycled pid's children rather than this daemon's terminals.
  const verifiedPidCall = source.search(/readVerifiedDaemonPid\s*\(/)
  const evidenceCall = source.match(/raiseOccupancyWithProcessEvidence\s*\(([^)]*)\)/)
  assert(verifiedPidCall !== -1, `${relativePath} never calls readVerifiedDaemonPid()`)
  assert(evidenceCall !== null, `${relativePath} never raises occupancy with process evidence`)
  assert(
    verifiedPidCall < evidenceCall.index,
    `${relativePath} raises occupancy with process evidence before verifying the recorded pid`
  )
  // Whatever identifier carries the pid, its declaration must come from the verified read.
  const evidencePidName = evidenceCall[1]
    .split(',')[1]
    ?.trim()
    .replace(/[^\w$]/g, '')
  assert(
    Boolean(evidencePidName),
    `could not read the pid argument of raiseOccupancyWithProcessEvidence: ${normalize(evidenceCall[1])}`
  )
  const evidencePidDecl = new RegExp(
    `const\\s+${evidencePidName}\\b[\\s\\S]{0,400}?readVerifiedDaemonPid\\s*\\(`
  )
  assert(
    evidencePidDecl.test(source),
    `${relativePath} passes '${evidencePidName}' to raiseOccupancyWithProcessEvidence without deriving it from readVerifiedDaemonPid — the evidence could then describe a recycled pid's children`
  )

  // 3. The 'occupied' branch holds and never kills.
  const occupiedGuard = source.match(/if\s*\(\s*occupancy\.state\s*===\s*'occupied'\s*\)\s*\{/)
  assert(occupiedGuard !== null, `${relativePath} has no 'occupancy.state === occupied' guard`)
  const occupiedBlock = extractBlock(source, occupiedGuard.index + occupiedGuard[0].length - 1)
  assert(occupiedBlock !== null, `could not parse the occupied branch in ${relativePath}`)
  const occupiedLine = lineOf(source, occupiedGuard.index)
  assert(
    !occupiedBlock.text.includes('killStaleDaemon'),
    `${relativePath}:${occupiedLine} calls killStaleDaemon inside the occupied branch`
  )

  // Holding requires BOTH: no hello ever completed, and only the process table could answer.
  // A daemon that did complete a hello is adoptable, so it must not be routed to a mode that
  // never adopts.
  const unverifiableGuard = occupiedBlock.text.match(
    /if\s*\(\s*health\s*===\s*'rejected'\s*\|\|\s*occupancy\.liveSessions\s*===\s*null\s*\)\s*\{/
  )
  assert(
    unverifiableGuard !== null,
    `${relativePath}:${occupiedLine} does not gate the hold on a daemon that cannot be adopted (rejected, or an unverifiable session count)`
  )
  const unverifiableBlock = extractBlock(
    occupiedBlock.text,
    unverifiableGuard.index + unverifiableGuard[0].length - 1
  )
  assert(unverifiableBlock !== null, 'could not parse the liveSessions === null branch')
  assert(
    normalize(unverifiableBlock.text).includes('return holdIncumbentDaemon()'),
    `${relativePath}:${occupiedLine} does not return holdIncumbentDaemon() when the session count came from the process table`
  )
  log(
    `phase 3: ${relativePath}:${occupiedLine} occupancy.state === 'occupied' + cannot-be-adopted -> return holdIncumbentDaemon(); the branch contains no kill`
  )

  // 3b. The unknown-hold: the protection that no longer depends on any timing budget. An
  //     unclassifiable daemon is held, not replaced, except where holding is unrecoverable.
  const unknownHold = source.match(
    /if\s*\(\s*occupancy\.state === 'unknown' &&[\s\S]{0,1500}?return holdIncumbentDaemon\(\)/
  )
  assert(
    unknownHold !== null,
    `${relativePath} does not hold on occupancy.state === 'unknown' — a daemon we could not classify is being replaced`
  )
  assert(
    unknownHold[0].includes("health !== 'rejected'"),
    `the unknown-hold does not exclude 'rejected', which can never be adopted: ${normalize(unknownHold[0])}`
  )
  assert(
    unknownHold[0].includes('endpointIsProvenDead'),
    `the unknown-hold does not exclude a proven-dead endpoint, so a cold start would be held: ${normalize(unknownHold[0])}`
  )
  log(
    `phase 3: ${relativePath}:${lineOf(source, unknownHold.index)} occupancy.state === 'unknown' + not-proven-dead + not-rejected -> return holdIncumbentDaemon()`
  )

  // 4. Ordering: every kill on this path is downstream of the occupied branch, so a hold
  //    returns before any of them can run.
  const killCalls = [...source.matchAll(/killStaleDaemon\s*\(/g)].map((match) => match.index)
  assert(killCalls.length > 0, `${relativePath} never calls killStaleDaemon()`)
  const killsBeforeTheDecision = killCalls.filter(
    (index) => index > evidenceCall.index && index < occupiedBlock.end
  )
  assert(
    killsBeforeTheDecision.length === 0,
    `${relativePath} kills at line(s) ${killsBeforeTheDecision.map((i) => lineOf(source, i)).join(', ')}, between resolving occupancy and the hold`
  )
  const killsBeforeTheUnknownHold = killCalls.filter(
    (index) => index > evidenceCall.index && index < unknownHold.index
  )
  assert(
    killsBeforeTheUnknownHold.length === 0,
    `${relativePath} kills at line(s) ${killsBeforeTheUnknownHold.map((i) => lineOf(source, i)).join(', ')}, before the unknown-hold can return`
  )
  const fallThroughKill = killCalls.find((index) => index > unknownHold.index)
  assert(
    fallThroughKill !== undefined,
    `${relativePath} has no killStaleDaemon() after the occupied branch — the replacement path is gone`
  )
  const killLines = killCalls.map((index) => lineOf(source, index)).join(', ')
  log(
    `phase 3: every killStaleDaemon() call site in the file is at line(s) ${killLines} — all downstream of the occupied branch, which returns at line ${lineOf(source, occupiedBlock.start)}`
  )
  log(
    'phase 3 RESULT: statically, the failed-health-check path resolves occupancy from a verified pid and returns a held handle before any kill. This proves the source ordering and branch contents; it does NOT execute daemon-init.ts (it imports electron), so the runtime proof stops at the inputs phase 2 produced with real processes.'
  )
}
