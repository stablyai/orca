// Minimal ustar writer for the Vercel files API (POST .../fs/write takes a gzipped tarball, the same
// format @vercel/sandbox's FileWriter streams). Workers have no tar library; one regular file plus
// its parent directories is all the control plane ever writes.

const BLOCK = 512

function octal(value: number, width: number): string {
  // width includes the trailing NUL.
  return value.toString(8).padStart(width - 1, '0')
}

function header(path: string, entry: { type: 'file' | 'dir'; size: number; mode: number; mtime: number }): Uint8Array<ArrayBuffer> {
  const block = new Uint8Array(BLOCK)
  const encoder = new TextEncoder()
  const put = (offset: number, text: string, width: number) => {
    const bytes = encoder.encode(text)
    if (bytes.length > width) {
      throw new Error('tar_field_too_long')
    }
    block.set(bytes, offset)
  }
  // Long paths split at a slash: prefix (155) + "/" + name (100).
  let name = path
  let prefix = ''
  if (encoder.encode(path).length > 100) {
    const cut = path.lastIndexOf('/', path.length - 2)
    if (cut <= 0) {
      throw new Error('tar_name_too_long')
    }
    prefix = path.slice(0, cut)
    name = path.slice(cut + 1)
  }
  put(0, name, 100)
  put(100, octal(entry.mode, 8), 8)
  put(108, octal(0, 8), 8)
  put(116, octal(0, 8), 8)
  put(124, octal(entry.size, 12), 12)
  put(136, octal(Math.floor(entry.mtime / 1000), 12), 12)
  block.fill(0x20, 148, 156) // checksum field counts as spaces while summing
  put(156, entry.type === 'dir' ? '5' : '0', 1)
  put(257, 'ustar\u000000', 8)
  put(345, prefix, 155)
  const sum = block.reduce((total, byte) => total + byte, 0)
  put(148, `${octal(sum, 7)}\u0000 `, 8)
  return block
}

/**
 * A gzipped tarball holding `dirs` (created first, mode 0755) and one file at `path` (0644). Paths
 * are relative to the extraction directory and must not contain `..` segments.
 */
export async function tarGzipFile(input: { dirs: string[]; path: string; bytes: Uint8Array; mtime: number }): Promise<ArrayBuffer> {
  for (const p of [...input.dirs, input.path]) {
    if (p.startsWith('/') || p.split('/').some((segment) => segment === '..' || segment === '')) {
      throw new Error('tar_bad_path')
    }
  }
  const padding = (BLOCK - (input.bytes.length % BLOCK)) % BLOCK
  // Blob parts must be ArrayBuffer-backed; the copy of `bytes` also detaches it from a shared buffer.
  const parts: Uint8Array<ArrayBuffer>[] = [
    ...input.dirs.map((dir) => header(`${dir}/`, { type: 'dir', size: 0, mode: 0o755, mtime: input.mtime })),
    header(input.path, { type: 'file', size: input.bytes.length, mode: 0o644, mtime: input.mtime }),
    input.bytes.slice(),
    new Uint8Array(padding),
    new Uint8Array(BLOCK * 2) // end-of-archive marker
  ]
  // acceptance compiles this file with Node's lib types, which don't take Uint8Array<ArrayBufferLike> as a blob part.
  const stream = new Blob(parts as ConstructorParameters<typeof Blob>[0]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Response(stream).arrayBuffer()
}
