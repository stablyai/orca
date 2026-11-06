import { runProcess } from '@orca/process-host'
import { parseWslUncPath, toWindowsWslUncPath } from '../../shared/wsl-paths'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { wslExeProcessSpec } from '../wsl/execution/wsl-exe-process'
import { admitWslTranscriptPath } from './wsl-transcript-running-admission'
import { runWslTranscriptFsTask } from './wsl-transcript-fs-gate'

// SQLite locks and symlink containment must be checked inside the guest, not over 9P.
const LOOKUP = String.raw`
import json, re, sqlite3, sys
from contextlib import closing
from pathlib import Path

def lookup(sessions, thread_id, distro):
    root = Path(sessions)
    databases = []
    for path in root.parent.iterdir():
        match = re.fullmatch(r"state_(\d+)\.sqlite", path.name)
        if match:
            databases.append((int(match[1]), path))
    if not databases:
        return None
    database = max(databases, key=lambda item: item[0])[1]
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=0)) as db:
        row = db.execute("SELECT rollout_path FROM threads WHERE id = ?", (thread_id,)).fetchone()
    if not row or not isinstance(row[0], str):
        return None
    candidate = row[0]
    if not candidate.startswith("/") or candidate.startswith("//"):
        match = re.fullmatch(r"//(?:wsl\.localhost|wsl\$)/([^/]+)(/.*)", candidate.replace("\\", "/"), re.I)
        if not match or match[1].lower() != distro.lower():
            return None
        candidate = match[2]
    if "\\" in candidate or "\0" in candidate:
        return None
    target = Path(candidate).resolve(strict=True)
    canonical_root = root.resolve(strict=True)
    if canonical_root not in target.parents or not target.is_file():
        return None
    if any(part.endswith((".", " ")) or re.search(r'[\\\x00-\x1f<>:"|?*]', part) for part in target.parts[1:]):
        return None
    return str(target)

try:
    result = lookup(*sys.argv[1:])
except (OSError, ValueError, sqlite3.Error):
    result = None
print(json.dumps(result))
`

/** An absent/unusable index (including guests without Python SQLite) preserves filename fallback. */
export async function findIndexedWslCodexRollout(
  root: string,
  sessionId: string,
  signal?: AbortSignal
): Promise<string | null> {
  signal?.throwIfAborted()
  const wsl = parseWslUncPath(root)
  if (!wsl) {
    return null
  }
  await admitWslTranscriptPath(root)
  return runWslTranscriptFsTask(
    { operation: 'readfile', path: root, priority: 'exact', signal, dedupe: false },
    async (taskSignal) => {
      await admitWslTranscriptPath(root)
      taskSignal.throwIfAborted()
      try {
        const result = await runProcess({
          ...wslExeProcessSpec(
            buildWslExecArgs(wsl.distro, [
              '/usr/bin/python3',
              '-I',
              '-c',
              LOOKUP,
              wsl.linuxPath,
              sessionId,
              wsl.distro
            ]),
            5_000
          ),
          signal: taskSignal,
          maxOutputBytes: 16 * 1024
        })
        if (result.code !== 0 || result.timedOut || result.outputTruncated) {
          return null
        }
        const path: unknown = JSON.parse(result.stdout)
        return typeof path === 'string' &&
          path.startsWith('/') &&
          !path.startsWith('//') &&
          !path.includes('\\') &&
          !path.includes('\0')
          ? toWindowsWslUncPath(path, wsl.distro)
          : null
      } catch {
        taskSignal.throwIfAborted()
        return null
      }
    }
  )
}
