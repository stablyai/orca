// GNU/BusyBox provide sha256sum; macOS provides shasum. Both print the digest first.
export function remoteSha256Command(path: string): string {
  return `{ sha256sum ${path} 2>/dev/null || shasum -a 256 ${path}; } | cut -d' ' -f1`
}
