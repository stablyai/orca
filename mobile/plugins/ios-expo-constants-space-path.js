const fs = require('node:fs/promises')
const path = require('node:path')
const { withDangerousMod } = require('expo/config-plugins')

async function quoteConstantsProjectDirectory(scriptPath) {
  const source = await fs.readFile(scriptPath, 'utf8')
  const patched = source.replace(
    'PROJECT_DIR_BASENAME=$(basename $PROJECT_DIR)',
    'PROJECT_DIR_BASENAME=$(basename "$PROJECT_DIR")'
  )
  if (patched !== source) {
    await fs.writeFile(scriptPath, patched)
  }
}

module.exports = (config) =>
  withDangerousMod(config, [
    'ios',
    async (mod) => {
      const packageJson = require.resolve('expo-constants/package.json', {
        paths: [mod.modRequest.projectRoot]
      })
      await quoteConstantsProjectDirectory(
        path.join(path.dirname(packageJson), 'scripts', 'get-app-config-ios.sh')
      )
      return mod
    }
  ])

module.exports.quoteConstantsProjectDirectory = quoteConstantsProjectDirectory
