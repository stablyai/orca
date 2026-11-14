export type GlibcVersion = { major: number; minor: number }
export type LinuxLibcFacts = { libc: 'glibc' | 'musl'; glibc: GlibcVersion | null }

/** The host answered, but with no recognizable library evidence. */
export class UnidentifiedHostLibcError extends Error {
  constructor() {
    super('Could not identify the host C library for the bundled Orca runtime')
    this.name = 'UnidentifiedHostLibcError'
  }
}

const GNU_LDD_BANNER = /^ldd[ \t]+\([^\r\n)]*\b(?:glibc|GNU libc|GNU C Library)\b[^\r\n)]*\)/im
const GNU_RELEASE_BANNER =
  /^(?:ld\.so[ \t]+\([^\r\n)]*\b(?:glibc|GNU libc)\b[^\r\n)]*\)|GNU C Library\b)[^\r\n]*\brelease version (\d+)\.(\d+)(?:[.,\s]|$)/im
const GETCONF_VERSION = /^glibc[ \t]+(\d+)\.(\d+)[ \t]*\r?$/im

export function parseLinuxLibc(output: string): LinuxLibcFacts['libc'] {
  if (/^musl libc(?:[ \t(]|\r?$)/im.test(output)) {
    return 'musl'
  }
  if (
    GNU_LDD_BANNER.test(output) ||
    GNU_RELEASE_BANNER.test(output) ||
    GETCONF_VERSION.test(output)
  ) {
    return 'glibc'
  }
  throw new UnidentifiedHostLibcError()
}

export function parseGlibcVersion(output: string): GlibcVersion | null {
  const lddLine = output.split(/\r?\n/).find((line) => GNU_LDD_BANNER.test(line))
  const lddVersion = lddLine ? /[ \t](\d+)\.(\d+)[ \t]*$/.exec(lddLine) : null
  const match = lddVersion ?? GETCONF_VERSION.exec(output) ?? GNU_RELEASE_BANNER.exec(output)
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null
}

/** The first probe, which answers on nearly every glibc or musl host; callers may run it early. */
export const LINUX_LIBC_FIRST_PROBE = 'LC_ALL=C ldd --version 2>&1 || true'

const PROBES = [
  LINUX_LIBC_FIRST_PROBE,
  'LC_ALL=C getconf GNU_LIBC_VERSION 2>/dev/null || true',
  // Appliances may omit both tools; newer GNU loaders can report their own version.
  'for loader in /lib/ld-linux-x86-64.so.2 /lib64/ld-linux-x86-64.so.2 /lib/ld-linux-aarch64.so.1; do ' +
    '[ ! -x "$loader" ] || LC_ALL=C "$loader" --version 2>/dev/null; done; true',
  // Older GNU loaders lack --version, while libc itself prints a release banner.
  'for library in /lib/libc.so.6 /lib64/libc.so.6 /lib/x86_64-linux-gnu/libc.so.6 /lib/aarch64-linux-gnu/libc.so.6; do ' +
    '[ ! -x "$library" ] || LC_ALL=C "$library" 2>/dev/null; done; true',
  // musl writes its version to stderr and exits nonzero when invoked without a program.
  'for loader in /lib/ld-musl-*.so.1; do ' +
    '[ ! -x "$loader" ] || LC_ALL=C "$loader" 2>&1; done; true'
]

export async function probeLinuxLibc(
  exec: (command: string) => Promise<string>
): Promise<LinuxLibcFacts> {
  for (const probe of PROBES) {
    const output = await exec(probe)
    try {
      const libc = parseLinuxLibc(output)
      return { libc, glibc: libc === 'glibc' ? parseGlibcVersion(output) : null }
    } catch (error) {
      if (!(error instanceof UnidentifiedHostLibcError)) {
        throw error
      }
    }
  }
  throw new UnidentifiedHostLibcError()
}
