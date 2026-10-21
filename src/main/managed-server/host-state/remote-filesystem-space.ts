/** Free space on a POSIX host, read from `df -Pk` (GNU, BSD and BusyBox agree on its columns). */

/** The available-KB column of one `df -Pk` data line, or null when the line has none. */
export function dfAvailableKb(line: string | undefined): number | null {
  const available = line?.trim().split(/\s+/u)[3]
  return available && /^\d+$/u.test(available) ? Number(available) : null
}

export function formatKb(kb: number): string {
  if (kb < 1024) {
    return `${kb} KB`
  }
  const mb = kb / 1024
  return mb < 1024 ? `${mb.toFixed(1)} MB` : `${(mb / 1024).toFixed(1)} GB`
}
