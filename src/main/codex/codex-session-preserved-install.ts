import { existsSync, linkSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  clearCopiedCodexSessionMarker,
  writeCopiedCodexSessionMarker
} from './codex-session-copy-markers'
import {
  hasPreservedCodexSession,
  preservedCodexSessionPaths,
  writePreservedCodexSessionRecord
} from './codex-session-preserved-copies'

export type PreservedCodexSessionInstallArgs = {
  sourcePath: string
  targetPath: string
  relativePath: string
  replacementPath: string
  usesHardlink: boolean
  targetIdentityCheck: (candidatePath: string) => boolean
}

/** Installs one bounded refresh while permanently retaining every displaced inode. */
export function installWithPreservedCodexSession(
  args: PreservedCodexSessionInstallArgs
): boolean {
  const preservedPaths = preservedCodexSessionPaths(args.relativePath)
  const displacedTargetPath = `${preservedPaths.dataPath}.displaced-${process.pid}-${Date.now()}`
  if (
    hasPreservedCodexSession(args.relativePath) ||
    existsSync(displacedTargetPath) ||
    !args.targetIdentityCheck(args.targetPath)
  ) {
    return false
  }
  mkdirSync(dirname(preservedPaths.dataPath), { recursive: true })

  // Hardlinking first keeps the old inode reachable even if an already-open
  // writer appends after the canonical target name moves to the replacement.
  linkSync(args.targetPath, preservedPaths.dataPath)
  try {
    writePreservedCodexSessionRecord({
      relativePath: args.relativePath,
      sourcePath: args.sourcePath,
      originalTargetPath: args.targetPath,
      displacedTargetPath
    })
  } catch (error) {
    // The deterministic preserved path is itself the recovery pointer. Once
    // created it is never removed automatically, even if its record failed.
    console.warn(
      '[codex-session-bridge] Preserved Codex session without sidecar record:',
      preservedPaths.dataPath,
      error
    )
    return false
  }
  try {
    if (!args.targetIdentityCheck(preservedPaths.dataPath)) {
      return false
    }

    // Rename, rather than unlink, whichever inode is at the canonical name at
    // commit time. A racing replacement is therefore preserved too.
    renameSync(args.targetPath, displacedTargetPath)
    if (!installReplacementExclusively(args, displacedTargetPath)) {
      return false
    }

    updateInstalledBridgeMarker(args)
    return true
  } catch (error) {
    console.warn(
      '[codex-session-bridge] Preserved Codex session requires manual review:',
      preservedPaths.dataPath,
      error
    )
    return false
  }
}

function installReplacementExclusively(
  args: PreservedCodexSessionInstallArgs,
  displacedTargetPath: string
): boolean {
  try {
    // replacementPath is in the target directory, so this is an exclusive,
    // complete-file publication even when source and target volumes differ.
    linkSync(args.replacementPath, args.targetPath)
    return true
  } catch (error) {
    if (existsSync(args.targetPath)) {
      console.warn(
        '[codex-session-bridge] Target appeared during preserved install:',
        args.targetPath,
        error
      )
      return false
    }
    try {
      // Exclusive restore cannot overwrite a target that appears after the
      // existence check; displaced and snapshot names remain recoverable.
      linkSync(displacedTargetPath, args.targetPath)
    } catch (restoreError) {
      console.warn(
        '[codex-session-bridge] Preserved replacement restore requires review:',
        displacedTargetPath,
        restoreError
      )
    }
    console.warn(
      '[codex-session-bridge] Preserved replacement install failed:',
      args.targetPath,
      error
    )
    return false
  }
}

function updateInstalledBridgeMarker(args: PreservedCodexSessionInstallArgs): void {
  try {
    if (args.usesHardlink) {
      clearCopiedCodexSessionMarker(args.relativePath)
    } else {
      writeCopiedCodexSessionMarker(args.relativePath, args.sourcePath, args.targetPath)
    }
  } catch (error) {
    console.warn(
      '[codex-session-bridge] Installed preserved bridge without marker update:',
      args.targetPath,
      error
    )
  }
}
