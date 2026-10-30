/** Every call throws an Error whose message names the Win32 call and its error code. */

export type GrantAccessOptions = {
  /** Children inherit the grant (OI|CI). Only meaningful on a directory. */
  inheritable: boolean
  /**
   * SET_ACCESS: drop every explicit rule for the trustee, allow and deny, then grant exactly
   * `accessMask`. Otherwise GRANT_ACCESS: add `accessMask` to what the trustee is already allowed.
   */
  replace: boolean
}

/** The process token's user SID, e.g. `S-1-5-21-…-1001`. */
export declare function currentUserSid(): string

/**
 * One DACL entry as stored. `type` and `flags` are the raw ACE_HEADER bytes; `sid` is set only for
 * plain allow (0) and deny (1) ACEs and is null for every other type.
 */
export type WindowsAce = { type: number; flags: number; mask: number; sid: string | null }

/** `protected` is SE_DACL_PROTECTED. */
export type WindowsDacl = { protected: boolean; aces: WindowsAce[] }

/** The path's DACL as structure, or null for a NULL DACL (which grants everyone everything). */
export declare function getDaclAces(path: string): WindowsDacl | null

/**
 * Installs exactly the DACL in `sddl`. Its `P` flag picks protected or inheriting. A directory
 * propagates to every existing descendant, which is seconds on a large tree.
 */
export declare function setDaclSddl(path: string, sddl: string): void
export declare function setDaclSddlAsync(path: string, sddl: string): Promise<void>

/** Creates a NEW file already carrying the DACL in `sddl`, then writes `data` into it. */
export declare function createFileWithDacl(
  path: string,
  sddl: string,
  data: Uint8Array,
  strict?: boolean
): void

/** Read bounded regular-file bytes and their DACL through one handle, excluding writers/replacement. */
export declare function readFileWithDacl(
  path: string,
  maxBytes: number
): { data: Uint8Array; dacl: WindowsDacl | null } | null
/** Missing returns null; native read failures carry syscall='CredReadW' and numeric win32Code. */
export declare function readGenericCredential(target: string): Uint8Array | null
export declare function writeGenericCredential(target: string, user: string, data: Uint8Array): void

/**
 * Adds an allow rule for `sid` to the existing DACL, keeping its protection state; Windows orders
 * the result canonically. A NULL DACL already allows everyone, so it is left untouched.
 */
export declare function grantAccess(
  path: string,
  sid: string,
  accessMask: number,
  options: GrantAccessOptions
): void
export declare function grantAccessAsync(
  path: string,
  sid: string,
  accessMask: number,
  options: GrantAccessOptions
): Promise<void>

export type StdHandleInheritanceFailure = { stream: 'stdin' | 'stdout' | 'stderr'; code: number }

/**
 * Makes the process's std handles non-inheritable, skipping absent ones. Never throws; returns the
 * handles SetHandleInformation rejected (e.g. a legacy console pseudo-handle) with their Win32 code.
 */
export declare function clearStdHandleInheritance(): StdHandleInheritanceFailure[]

/** `exitWatchError` is the Win32 code when the exit can't be observed; the child still runs. */
export type IsolatedSpawnResult = { pid: number; exitWatchError: number | null }

/**
 * Starts `file` detached and hidden, inheriting only a NUL handle for its stdio, so none of this
 * process's other inheritable handles reach it. `commandLine` is the full, already quoted line
 * (argv[0] included); an empty `cwd` keeps ours; `environmentBlock` is `K=V\0…\0\0`. `onExit` gets the exit code and never
 * keeps the event loop alive. Throws an Error naming the failed Win32 call.
 */
export declare function spawnDetachedIsolated(
  file: string,
  commandLine: string,
  cwd: string,
  environmentBlock: string,
  onExit: (code: number) => void
): IsolatedSpawnResult

/** Whether the resolved binary exports `name`; loads it, but calls nothing else. */
export declare function hasNativeExport(name: string): boolean
