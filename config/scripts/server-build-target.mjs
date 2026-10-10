/** The build host's own server target (src/shared/node-runtime-pin.ts SERVER_TARGETS). */
export function currentTarget() {
  if (process.platform === 'darwin') {
    return `darwin-${process.arch}`
  }
  if (process.platform === 'win32') {
    return `win32-${process.arch}`
  }
  if (process.platform !== 'linux') {
    throw new Error(`Unsupported server platform: ${process.platform}`)
  }
  const glibc = process.report?.getReport()?.header?.glibcVersionRuntime
  return `linux-${process.arch}-${glibc ? 'glibc' : 'musl'}`
}
