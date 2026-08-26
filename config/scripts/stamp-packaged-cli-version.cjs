const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

function stampPackagedCliVersion(resourcesDir, appVersion) {
  const metadataPath = join(resourcesDir, 'app.asar.unpacked', 'out', 'package.json')
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
  metadata.version = appVersion
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')

  const stamped = JSON.parse(readFileSync(metadataPath, 'utf8'))
  if (stamped.version !== appVersion) {
    throw new Error(`Packaged CLI version stamp failed: ${metadataPath}`)
  }
  return metadataPath
}

module.exports = { stampPackagedCliVersion }
