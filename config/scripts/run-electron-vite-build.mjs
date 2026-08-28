import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { appendBuildOldSpaceOption } from './node-old-space-limit.mjs'
import {
  readBuildProvenance,
  verifyInheritedBuildProvenance,
  writeBuildArtifactManifest
} from './build-provenance.mjs'

const require = createRequire(import.meta.url)
const electronVitePackageJson = require.resolve('electron-vite/package.json')
const electronViteCli = path.join(path.dirname(electronVitePackageJson), 'bin', 'electron-vite.js')

// Release builds have started OOMing on GitHub's macOS runners during the
// renderer bundle. Reserve memory on smaller hosts so the OS does not kill Vite.
const nodeOptions = appendBuildOldSpaceOption(process.env.NODE_OPTIONS)

// Why here and not in the vite config: vite writes its own
// `electron.vite.config.<timestamp>.mjs` scratch file into the repo root BEFORE
// evaluating the config, so provenance computed there always reads the tree as
// dirty and the artifact could never name the commit it was built from. This
// runs first, while the tree is still what the operator left it.
const provenance = process.env.ORCA_BUILD_PROVENANCE_JSON
  ? JSON.stringify(
      verifyInheritedBuildProvenance(process.env.ORCA_BUILD_PROVENANCE_JSON, process.cwd())
    )
  : JSON.stringify(readBuildProvenance(process.cwd()))

const child = spawn(process.execPath, [electronViteCli, 'build', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_OPTIONS: nodeOptions,
    ORCA_BUILD_PROVENANCE_JSON: provenance
  }
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  const exitCode = code ?? 1
  if (exitCode === 0 && !process.env.ORCA_ELECTRON_VITE_TARGET) {
    writeBuildArtifactManifest(process.cwd(), provenance)
  }
  process.exit(exitCode)
})
