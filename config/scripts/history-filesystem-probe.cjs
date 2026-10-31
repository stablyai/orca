const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

// A real exclusive consuming operation, not just a successful module load.
exports.probeHistoryFilesystem = (binding) => {
  const path = mkdtempSync(join(tmpdir(), 'orca-history-probe-'))
  let root, source, destination
  try {
    root = binding.openDirectory(path, false)
    root.mkdir('source')
    root.mkdir('destination')
    source = root.open('source')
    destination = root.open('destination')
    writeFileSync(join(path, 'source', 'entry'), 'original')
    writeFileSync(join(path, 'destination', 'entry'), 'winner')
    if (
      source.move('entry', destination, 'entry') !== 'collision' ||
      readFileSync(join(path, 'source', 'entry'), 'utf8') !== 'original' ||
      readFileSync(join(path, 'destination', 'entry'), 'utf8') !== 'winner' ||
      source.move('entry', destination, 'other') !== 'moved' ||
      existsSync(join(path, 'source', 'entry')) ||
      readFileSync(join(path, 'destination', 'other'), 'utf8') !== 'original'
    ) {
      throw new Error('History filesystem exclusive move contract failed')
    }
  } finally {
    source?.close()
    destination?.close()
    root?.close()
    rmSync(path, { recursive: true, force: true })
  }
}
