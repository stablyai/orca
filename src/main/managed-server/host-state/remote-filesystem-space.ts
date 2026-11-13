/** Read the shared GNU/BSD/BusyBox df -Pk available-KB column. */
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
