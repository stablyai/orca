export const GENERATED_NODE_MANAGED_FILE_MAX_BYTES = 64 * 1024

// Why: emitted runtimes cannot import Orca's reader; fixed capacity also catches growth after stat.
export function getGeneratedNodeBoundedFileReaderSourceLines(options?: {
  typed?: boolean
}): string[] {
  const signature = options?.typed
    ? `function readOrcaManagedFileWithinLimit(fs: any, path: string, maxBytes = ${GENERATED_NODE_MANAGED_FILE_MAX_BYTES}): string {`
    : `function readOrcaManagedFileWithinLimit(fs, path, maxBytes = ${GENERATED_NODE_MANAGED_FILE_MAX_BYTES}) {`
  return [
    signature,
    "  const descriptor = fs.openSync(path, 'r');",
    '  try {',
    '    const buffer = Buffer.allocUnsafe(maxBytes + 1);',
    '    let offset = 0;',
    '    while (offset < buffer.length) {',
    '      const bytesRead = fs.readSync(descriptor, buffer, offset, buffer.length - offset, null);',
    '      if (bytesRead === 0) break;',
    '      offset += bytesRead;',
    '    }',
    '    if (offset > maxBytes) {',
    "      throw Object.assign(new Error('Managed Orca file exceeds ' + maxBytes + ' bytes'), { code: 'EFBIG' });",
    '    }',
    "    return buffer.toString('utf8', 0, offset);",
    '  } finally {',
    '    fs.closeSync(descriptor);',
    '  }',
    '}'
  ]
}
