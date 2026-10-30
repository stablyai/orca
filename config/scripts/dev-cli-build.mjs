import { buildCli } from './build-cli.mjs'
import { resolveBuildSourceCommit } from './build-source-commit.mjs'
import { verifyPackageCliBin } from './verify-cli-bin.mjs'

// Why: the dev wrappers run out/cli, which electron-vite never rebuilds; a stale CLI can predate the app's protocol.
export async function buildDevCli() {
  try {
    await buildCli()
    verifyPackageCliBin({
      fixExecutable: true,
      fixPackageJson: true,
      sourceCommit: resolveBuildSourceCommit()
    })
  } catch (error) {
    console.error(
      `[orca-dev] CLI build failed; orca-dev keeps its previous build: ${error.message}`
    )
  }
}
