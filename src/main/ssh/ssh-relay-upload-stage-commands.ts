import { shellEscape } from './ssh-connection-utils'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import {
  RELAY_UPLOAD_IDENTITY_FILE_NAME as IDENTITY_FILE_NAME,
  RELAY_UPLOAD_OWNER_FILE_NAME as OWNER_FILE_NAME,
  RELAY_UPLOAD_PROMOTION_RESULT_PREFIX as PROMOTION_RESULT_PREFIX,
  RELAY_UPLOAD_SLOT_RESULT_PREFIX as SLOT_RESULT_PREFIX,
  RELAY_UPLOAD_STAGE_POOL_NAME,
  RELAY_UPLOAD_STAGE_SLOT_COUNT,
  RELAY_UPLOAD_STAGE_STALE_SECONDS,
  type RelayUploadStageSlot
} from './ssh-relay-upload-stage-contract'
import {
  cleanupWindowsRelayUploadStageCommand,
  promoteWindowsRelayUploadStageCommand,
  recoverWindowsRelayUploadStageCommand,
  reserveWindowsRelayUploadStageCommand
} from './ssh-relay-upload-stage-windows-commands'

export {
  RELAY_UPLOAD_STAGE_POOL_NAME,
  RELAY_UPLOAD_STAGE_SLOT_COUNT,
  RELAY_UPLOAD_STAGE_STALE_SECONDS,
  type RelayUploadStageSlot
} from './ssh-relay-upload-stage-contract'

const OWNER_PATTERN = /^\.sftp-namespace-[0-9a-f]{32}$/u

function assertOwner(owner: string): void {
  if (!OWNER_PATTERN.test(owner)) {
    throw new Error('Invalid relay upload stage owner')
  }
}

function slotPaths(
  host: RemoteHostPlatform,
  poolDir: string,
  slotName: string
): RelayUploadStageSlot {
  if (!/^slot-[0-7]$/u.test(slotName)) {
    throw new Error('Invalid relay upload stage slot')
  }
  return {
    poolDir,
    slotName,
    slotDir: joinRemotePath(host, poolDir, slotName),
    claimDir: joinRemotePath(host, poolDir, `claim-${slotName.slice(5)}`),
    deleteDir: joinRemotePath(host, poolDir, `delete-${slotName.slice(5)}`)
  }
}

export function reserveRelayUploadStageCommand(
  host: RemoteHostPlatform,
  poolDir: string,
  owner: string
): string {
  assertOwner(owner)
  return isWindowsRemoteHost(host)
    ? reserveWindowsRelayUploadStageCommand(poolDir, owner)
    : reservePosixStageCommand(poolDir, owner)
}

export function parseReservedRelayUploadStage(
  host: RemoteHostPlatform,
  poolDir: string,
  owner: string,
  output: string
): RelayUploadStageSlot {
  assertOwner(owner)
  const authenticatedPrefix = `${SLOT_RESULT_PREFIX}${owner}:`
  const line = output
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(authenticatedPrefix))
  if (!line) {
    throw new Error('Remote relay upload stage reservation returned no authenticated slot')
  }
  return slotPaths(host, poolDir, line.slice(authenticatedPrefix.length))
}

export function promoteOwnedRelayUploadStageCommand(
  host: RemoteHostPlatform,
  stage: RelayUploadStageSlot,
  owner: string,
  destinationDir: string
): string {
  assertOwner(owner)
  return isWindowsRemoteHost(host)
    ? promoteWindowsRelayUploadStageCommand(stage, owner, destinationDir)
    : promotePosixStageCommand(stage, owner, destinationDir)
}

export function relayUploadStagePromotionConfirmed(owner: string, output: string): boolean {
  assertOwner(owner)
  return output
    .split(/\r?\n/u)
    .some((line) => line.trim() === `${PROMOTION_RESULT_PREFIX}${owner}:PROMOTED`)
}

export function cleanupOwnedRelayUploadStageCommand(
  host: RemoteHostPlatform,
  stage: RelayUploadStageSlot,
  owner: string
): string {
  assertOwner(owner)
  return isWindowsRemoteHost(host)
    ? cleanupWindowsRelayUploadStageCommand(stage, owner)
    : cleanupPosixStageCommand(stage, owner)
}

export function recoverOneStaleRelayUploadStageCommand(
  host: RemoteHostPlatform,
  poolDir: string,
  staleSeconds = RELAY_UPLOAD_STAGE_STALE_SECONDS
): string {
  const cutoffSeconds = Math.max(1, Math.ceil(staleSeconds))
  return isWindowsRemoteHost(host)
    ? recoverWindowsRelayUploadStageCommand(poolDir, cutoffSeconds)
    : recoverPosixStageCommand(poolDir, Math.ceil(cutoffSeconds / 60))
}

function reservePosixStageCommand(poolDir: string, owner: string): string {
  const pool = shellEscape(poolDir)
  const slots = Array.from({ length: RELAY_UPLOAD_STAGE_SLOT_COUNT }, (_, index) => index).join(' ')
  return [
    'umask 077;',
    `pool=${pool};`,
    'mkdir -p "$pool" || exit 1;',
    '[ -d "$pool" ] && [ ! -L "$pool" ] || exit 1;',
    `for n in ${slots}; do`,
    'slot="$pool/slot-$n"; claim="$pool/claim-$n"; deleting="$pool/delete-$n";',
    'if [ ! -e "$claim" ] && [ ! -L "$claim" ] && [ ! -e "$deleting" ] && [ ! -L "$deleting" ] && mkdir "$slot" 2>/dev/null; then',
    `identity=$(ls -id "$slot" 2>/dev/null | awk '{print $1}') || identity=;`,
    `if [ -n "$identity" ] && mkdir "$slot/payload" && printf '%s' ${shellEscape(owner)} > "$slot/${OWNER_FILE_NAME}" && printf '%s' "$identity" > "$slot/${IDENTITY_FILE_NAME}" && : > "$slot/${owner}"; then`,
    `printf '%s%s:%s\\n' ${shellEscape(SLOT_RESULT_PREFIX)} ${shellEscape(owner)} "slot-$n"; exit 0;`,
    'fi;',
    'fi;',
    'done;',
    `printf '%s\\n' 'Orca relay upload staging quota is full; reconnect after 40 minutes or inspect .orca-remote/${RELAY_UPLOAD_STAGE_POOL_NAME}' >&2;`,
    'exit 75'
  ].join(' ')
}

function posixClaimPrelude(stage: RelayUploadStageSlot): string {
  return [
    `pool=${shellEscape(stage.poolDir)}; slot=${shellEscape(stage.slotDir)}; claim=${shellEscape(stage.claimDir)}; deleting=${shellEscape(stage.deleteDir)};`,
    '[ -d "$pool" ] && [ ! -L "$pool" ] || exit 0;',
    '[ ! -e "$claim" ] && [ ! -L "$claim" ] && [ ! -e "$deleting" ] && [ ! -L "$deleting" ] || exit 0;',
    'mv "$slot" "$claim" 2>/dev/null || exit 0;'
  ].join(' ')
}

function posixRestoreClaim(): string {
  return 'if [ ! -e "$slot" ] && [ ! -L "$slot" ]; then mv "$claim" "$slot" 2>/dev/null || true; fi;'
}

function posixOwnedDirectoryCheck(
  pathVariable: string,
  owner: string,
  requirePayload: boolean
): string {
  const path = `$${pathVariable}`
  const checks = [
    `owner_file="${path}/${OWNER_FILE_NAME}";`,
    `identity_file="${path}/${IDENTITY_FILE_NAME}";`,
    `actual=$(cat "$owner_file" 2>/dev/null) || actual=;`,
    `expected_identity=$(cat "$identity_file" 2>/dev/null) || expected_identity=;`,
    `identity=$(ls -id "${path}" 2>/dev/null | awk '{print $1}') || identity=;`,
    `[ -n "$identity" ] && [ "$identity" = "$expected_identity" ] && [ -d "${path}" ] && [ ! -L "${path}" ] && [ -f "$owner_file" ] && [ ! -L "$owner_file" ] && [ -f "$identity_file" ] && [ ! -L "$identity_file" ] && [ "$actual" = ${shellEscape(owner)} ]`
  ]
  if (requirePayload) {
    checks.push(
      `&& payload="${path}/payload" && [ -d "$payload" ] && [ ! -L "$payload" ]`,
      `&& payload_identity=$(ls -id "$payload" 2>/dev/null | awk '{print $1}') && [ -n "$payload_identity" ]`,
      '&& links=$(find "$payload" -type l -print -quit 2>/dev/null) && [ -z "$links" ]'
    )
  }
  return checks.join(' ')
}

function posixMoveOwnedClaimToDelete(owner: string): string {
  return [
    '[ ! -e "$deleting" ] && [ ! -L "$deleting" ] || exit 0;',
    'mv "$claim" "$deleting" 2>/dev/null || exit 0;',
    `if ${posixOwnedDirectoryCheck('deleting', owner, true)} && [ "$identity" = "$claim_identity" ]; then`,
    'rm -rf "$deleting";',
    'else',
    'if [ ! -e "$claim" ] && [ ! -L "$claim" ]; then mv "$deleting" "$claim" 2>/dev/null || true; fi;',
    'fi;'
  ].join(' ')
}

function promotePosixStageCommand(
  stage: RelayUploadStageSlot,
  owner: string,
  destinationDir: string
): string {
  const expected = shellEscape(owner)
  return [
    posixClaimPrelude(stage),
    `if ! { ${posixOwnedDirectoryCheck('claim', owner, true)}; }; then`,
    posixRestoreClaim(),
    `printf '%s%s:OWNERSHIP_LOST\\n' ${shellEscape(PROMOTION_RESULT_PREFIX)} ${expected}; exit 0;`,
    'fi;',
    'claim_identity="$identity";',
    `if (cd "$payload" && [ "$(ls -id . 2>/dev/null | awk '{print $1}')" = "$payload_identity" ] && cp -a . ${shellEscape(destinationDir)}/); then`,
    posixMoveOwnedClaimToDelete(owner),
    `printf '%s%s:PROMOTED\\n' ${shellEscape(PROMOTION_RESULT_PREFIX)} ${expected}; exit 0;`,
    'fi;',
    'exit 1'
  ].join(' ')
}

function cleanupPosixStageCommand(stage: RelayUploadStageSlot, owner: string): string {
  return [
    posixClaimPrelude(stage),
    `if ${posixOwnedDirectoryCheck('claim', owner, true)}; then`,
    'claim_identity="$identity";',
    posixMoveOwnedClaimToDelete(owner),
    'else',
    posixRestoreClaim(),
    'fi;',
    'exit 0'
  ].join(' ')
}

function recoverPosixStageCommand(poolDir: string, staleMinutes: number): string {
  const pool = shellEscape(poolDir)
  const slots = Array.from({ length: RELAY_UPLOAD_STAGE_SLOT_COUNT }, (_, index) => index).join(' ')
  return [
    `pool=${pool}; [ -d "$pool" ] && [ ! -L "$pool" ] || exit 0;`,
    `for n in ${slots}; do`,
    'slot="$pool/slot-$n"; claim="$pool/claim-$n"; deleting="$pool/delete-$n";',
    `if [ -d "$deleting" ] && [ ! -L "$deleting" ]; then owner_file="$deleting/${OWNER_FILE_NAME}"; identity_file="$deleting/${IDENTITY_FILE_NAME}"; deleting_actual=$(cat "$owner_file" 2>/dev/null) || deleting_actual=; expected_identity=$(cat "$identity_file" 2>/dev/null) || expected_identity=; deleting_identity=$(ls -id "$deleting" 2>/dev/null | awk '{print $1}') || deleting_identity=; deleting_old=$(find "$owner_file" -prune -type f -mmin +${staleMinutes} -print 2>/dev/null) || deleting_old=; if [ -n "$deleting_identity" ] && [ "$deleting_identity" = "$expected_identity" ] && [ -f "$owner_file" ] && [ ! -L "$owner_file" ] && [ -f "$identity_file" ] && [ ! -L "$identity_file" ] && printf '%s' "$deleting_actual" | grep -Eq '^\\.sftp-namespace-[0-9a-f]{32}$' && [ -n "$deleting_old" ] && links=$(find "$deleting" -type l -print -quit 2>/dev/null) && [ -z "$links" ]; then rm -rf "$deleting"; exit 0; fi; fi;`,
    'if [ ! -e "$claim" ] && [ ! -L "$claim" ] && [ ! -e "$deleting" ] && [ ! -L "$deleting" ] && [ -d "$slot" ] && [ ! -L "$slot" ] &&',
    `old=$(find "$slot/${OWNER_FILE_NAME}" -prune -type f -mmin +${staleMinutes} -print 2>/dev/null) && [ -n "$old" ]; then`,
    'mv "$slot" "$claim" 2>/dev/null || continue;',
    'fi;',
    `owner_file="$claim/${OWNER_FILE_NAME}"; identity_file="$claim/${IDENTITY_FILE_NAME}"; actual=$(cat "$owner_file" 2>/dev/null) || actual=; expected_identity=$(cat "$identity_file" 2>/dev/null) || expected_identity=; identity=$(ls -id "$claim" 2>/dev/null | awk '{print $1}') || identity=; old=$(find "$owner_file" -prune -type f -mmin +${staleMinutes} -print 2>/dev/null) || old=;`,
    `if [ -n "$identity" ] && [ "$identity" = "$expected_identity" ] && [ -d "$claim" ] && [ ! -L "$claim" ] && [ -f "$owner_file" ] && [ ! -L "$owner_file" ] && [ -f "$identity_file" ] && [ ! -L "$identity_file" ] && printf '%s' "$actual" | grep -Eq '^\\.sftp-namespace-[0-9a-f]{32}$' && [ -n "$old" ]; then`,
    'claim_identity="$identity";',
    '[ ! -e "$deleting" ] && [ ! -L "$deleting" ] && mv "$claim" "$deleting" 2>/dev/null || continue;',
    `owner_file="$deleting/${OWNER_FILE_NAME}"; identity_file="$deleting/${IDENTITY_FILE_NAME}"; deleting_actual=$(cat "$owner_file" 2>/dev/null) || deleting_actual=; expected_identity=$(cat "$identity_file" 2>/dev/null) || expected_identity=; deleting_identity=$(ls -id "$deleting" 2>/dev/null | awk '{print $1}') || deleting_identity=; deleting_old=$(find "$owner_file" -prune -type f -mmin +${staleMinutes} -print 2>/dev/null) || deleting_old=;`,
    `if [ -n "$deleting_identity" ] && [ "$deleting_identity" = "$claim_identity" ] && [ "$deleting_identity" = "$expected_identity" ] && [ -d "$deleting" ] && [ ! -L "$deleting" ] && [ -f "$owner_file" ] && [ ! -L "$owner_file" ] && [ -f "$identity_file" ] && [ ! -L "$identity_file" ] && printf '%s' "$deleting_actual" | grep -Eq '^\\.sftp-namespace-[0-9a-f]{32}$' && [ -n "$deleting_old" ] && links=$(find "$deleting" -type l -print -quit 2>/dev/null) && [ -z "$links" ]; then`,
    'rm -rf "$deleting"; exit 0;',
    'fi;',
    'if [ ! -e "$claim" ] && [ ! -L "$claim" ]; then mv "$deleting" "$claim" 2>/dev/null || true; fi;',
    'continue;',
    'fi;',
    posixRestoreClaim(),
    'done;',
    'exit 0'
  ].join(' ')
}
