import { fileURLToPath } from 'node:url'

export function clipboardFilePathsFromUrls(
  urls: readonly string[],
  platform: NodeJS.Platform
): string[] {
  if (urls.some((url) => !url.startsWith('file://') || url.startsWith('file:///.file/id='))) {
    return []
  }
  const paths = urls.map((url) => fileURLToPath(url, { windows: platform === 'win32' }))
  return paths.some((path) => path.includes('\0')) ? [] : paths
}

export function clipboardFilePathsFromUriList(buffer: Buffer, platform: NodeJS.Platform): string[] {
  if (buffer.byteLength > 256 * 1024) {
    return []
  }
  const urls = buffer
    .toString('utf8')
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  return clipboardFilePathsFromUrls(urls, platform)
}
