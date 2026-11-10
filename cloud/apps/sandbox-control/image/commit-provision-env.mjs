// Provision env for the image files of THIS checkout (manifest pins + every image/vm/* entry point),
// printed as shell-quoted `export NAME=value` lines. source-build.sh sources it after fetching a
// commit, so a source-built golden always ships that commit's VM scripts and provision, never the
// (possibly older) copies embedded in the Worker that started the build. No dependencies: it runs
// before anything is installed. Mirrors golden-image.ts provisionEnv (golden-image.test.ts checks).
//   node image/commit-provision-env.mjs [imageDir]
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function commitProvisionEnv(imageDir) {
  const manifest = JSON.parse(readFileSync(join(imageDir, 'golden-image.manifest.json'), 'utf8'))
  const env = {
    AGENT_NPM_PACKAGES: manifest.agentCliPackages.join(' ')
  }
  if (manifest.gh?.version && manifest.gh?.sha256) {
    env.GH_VERSION = manifest.gh.version
    env.GH_SHA256 = manifest.gh.sha256
  }
  if (manifest.chrome) {
    env.CHROME_VERSION = manifest.chrome.version
    env.CHROME_SHA256 = manifest.chrome.sha256
  }
  if (manifest.cursorAgent) {
    env.CURSOR_AGENT_VERSION = manifest.cursorAgent.version
    env.CURSOR_AGENT_SHA256 = manifest.cursorAgent.sha256
  }
  if (manifest.desktop) {
    env.NOVNC_VERSION = manifest.desktop.novnc.version
    env.NOVNC_SHA256 = manifest.desktop.novnc.sha256
    env.WEBSOCKIFY_VERSION = manifest.desktop.websockify.version
    env.WEBSOCKIFY_SHA256 = manifest.desktop.websockify.sha256
  }
  const vmDir = join(imageDir, 'vm')
  for (const name of readdirSync(vmDir).sort()) {
    env[`ORCA_VM_SCRIPT_${name.replaceAll(/[-.]/g, '_')}`] = readFileSync(join(vmDir, name)).toString('base64')
  }
  return env
}

const shellQuote = (value) => `'${value.replaceAll("'", `'\\''`)}'`

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const imageDir = process.argv[2] ?? fileURLToPath(new URL('.', import.meta.url))
  for (const [name, value] of Object.entries(commitProvisionEnv(imageDir))) {
    process.stdout.write(`export ${name}=${shellQuote(value)}\n`)
  }
  process.stdout.write(`export ORCA_PROVISION_SCRIPT=${shellQuote(readFileSync(join(imageDir, 'provision-golden.sh')).toString('base64'))}\n`)
}
