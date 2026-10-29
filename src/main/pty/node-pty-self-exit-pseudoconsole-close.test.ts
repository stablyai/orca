import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Pin both self-exit leaks: the watcher must retain the baton for ClosePseudoConsole, and DLL kill must dispose conout without more data.
 * Windows 11 measurements (20 cycles): desktop +200 and relay +60 handles became flat with both fixes; desktop alone needs both.
 * Patch pins protect resyncs: leaked handles reference exited objects, so process/pipe disappearance could not detect them. */

const PATCH = readFileSync(join(__dirname, '../../../config/patches/node-pty@1.1.0.patch'), 'utf8')

/** Restrict to PtyKill: matching shared markers in PtyConnect made assertions vacuously pass. */
const ptyKillHunk = (() => {
  // Function context survives unrelated patch line-number changes.
  const header = /^@@ .* @@ static Napi::Value PtyKill\(.*$/m.exec(PATCH)
  if (!header) {
    throw new Error('no PtyKill hunk in config/patches/node-pty@1.1.0.patch')
  }
  const from = header.index
  const next = PATCH.indexOf('\n@@ ', from + 1)
  return PATCH.slice(from, next === -1 ? undefined : next)
})()

/** Missing markers must fail instead of making slice/order assertions vacuous. */
function indexIn(haystack: string, marker: string): number {
  const at = haystack.indexOf(marker)
  if (at === -1) {
    throw new Error(`marker not found in the PtyKill hunk: ${marker}`)
  }
  return at
}

describe('node-pty patch: pseudoconsole close on the self-exit path', () => {
  it('does not let the exit watcher free the baton while the close is still owed', () => {
    // Erasing outside consoleClosed loses the baton before self-exit cleanup can close it.
    expect(PATCH).toContain(
      [
        '+      baton->shellExited = true;',
        '+      if (baton->consoleClosed) {',
        '+        const bool removed = remove_pty_baton_locked(baton->id);',
        '+        assert(removed);',
        '+        (void)removed;',
        '+      }'
      ].join('\n')
    )
  })

  it('closes the pseudoconsole from PtyKill even after the shell has exited', () => {
    // hpc is copied out under the lock, so the close survives the baton's removal.
    expect(PATCH).toContain('+      hpc = handle->hpc;')
    expect(PATCH).toContain('+      pfnClosePseudoConsole(hpc);')
  })

  it('resolves the ConPTY DLL before it claims the close', () => {
    // Resolve DLL inside PtyKill before claiming consoleClosed; a throw afterward would prevent retries.
    const dllResolve = indexIn(
      ptyKillHunk,
      '+  HANDLE hLibrary = LoadConptyDll(info, useConptyDll);'
    )
    const claim = indexIn(ptyKillHunk, '+      handle->consoleClosed = true;')
    expect(dllResolve).toBeLessThan(claim)
  })

  it('reaches hShell only under the null check the watcher can trip', () => {
    // The watcher nulls hShell; both duplication and fallback termination need the guard.
    const start = indexIn(ptyKillHunk, '+      if (useConptyDll && handle->hShell != nullptr) {')
    const end = indexIn(ptyKillHunk, '+      if (handle->shellExited) {')
    const guarded = ptyKillHunk.slice(start, end)
    expect(guarded).toContain('DuplicateHandle(GetCurrentProcess(), handle->hShell')
    expect(guarded).toContain('TerminateProcess(handle->hShell, 1);')
    // Inspect added lines only; removed upstream lines deliberately retain the old unguarded call.
    const strayAdds = PATCH.replace(guarded, '')
      .split('\n')
      .filter((line) => line.startsWith('+') && line.includes('TerminateProcess(handle->hShell'))
    expect(strayAdds).toEqual([])
  })

  it('frees the baton from PtyKill when the shell has already exited', () => {
    // Without this handshake, self-exit then kill leaks a baton and its linear-scan vector entry.
    expect(ptyKillHunk).toContain(
      [
        '+      if (handle->shellExited) {',
        '+        const bool removed = remove_pty_baton_locked(id);',
        '+        assert(removed);',
        '+        (void)removed;'
      ].join('\n')
    )
  })

  it('still kills the shell when DuplicateHandle fails', () => {
    // Duplication failure must not look like self-exit and silently leave the shell alive.
    expect(PATCH).toContain(
      [
        '+          hShellDup = nullptr;',
        '+          TerminateProcess(handle->hShell, 1);',
        '+        }'
      ].join('\n')
    )
  })

  it('keeps the close idempotent so a second kill cannot double-close', () => {
    expect(PATCH).toContain('+    if (handle != nullptr && !handle->consoleClosed) {')
    expect(PATCH).toContain('+      handle->consoleClosed = true;')
  })
})

describe('node-pty patch: conout worker disposal on the self-exit path', () => {
  // Conout disposal accounts for eight of ten leaked desktop handles per cycle.
  it('disposes the conout worker unconditionally in the useConptyDll branch', () => {
    expect(PATCH).toContain('+                this._conoutSocketWorker.dispose();')
    // Self-exit can leave no further data to trigger this handler.
    expect(PATCH).toContain("-                this._outSocket.on('data', function () {")
    expect(PATCH).toContain('-                    _this._conoutSocketWorker.dispose();')
  })

  it('applies the same change to the TypeScript source the patch also carries', () => {
    expect(PATCH).toContain('+        this._conoutSocketWorker.dispose();')
    expect(PATCH).toContain("-        this._outSocket.on('data', () => {")
  })
})
