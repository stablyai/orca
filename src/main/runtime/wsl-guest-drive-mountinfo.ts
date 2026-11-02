// Windows drive mounts from /proc/self/mountinfo, which (unlike /proc/mounts) says which subfolder a bind mount shows.

export type WindowsDriveMount = {
  mountPoint: string
  /** The drive root as this computer spells it (`C:\`), or null when the mount is not a whole lettered drive. */
  windowsRoot: string | null
}

/** Decode mountinfo octal escapes, including whitespace and backslashes. */
function decodeField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8))
  )
}

function isWindowsDriveMount(type: string, superOptions: string): boolean {
  if (type === 'drvfs' || type === 'virtiofs') {
    return true
  }
  // /usr/lib/wsl/drivers and other WSL shares are 9p too; only aname=drvfs is a Windows drive.
  return type === '9p' && /(?:^|[,;])aname=drvfs(?:[,;]|$)/.test(superOptions)
}

export function parseWindowsDriveMountInfo(mountInfo: string): WindowsDriveMount[] {
  const mounts: WindowsDriveMount[] = []
  for (const line of mountInfo.split('\n')) {
    const fields = line.trim().split(/\s+/)
    const separator = fields.indexOf('-')
    if (separator < 5 || fields.length < separator + 3) {
      continue
    }
    const root = decodeField(fields[3])
    const mountPoint = decodeField(fields[4]).replace(/\/+$/, '')
    const [type, source, superOptions = ''] = fields.slice(separator + 1).map(decodeField)
    if (!mountPoint || !isWindowsDriveMount(type, superOptions)) {
      continue
    }
    // A wrong prefill is worse than none: only a whole drive named by letter maps to `X:\`.
    const letter = root === '/' ? /^([A-Za-z]):\\?$/.exec(source)?.[1] : undefined
    mounts.push({ mountPoint, windowsRoot: letter ? `${letter.toUpperCase()}:\\` : null })
  }
  return mounts
}
