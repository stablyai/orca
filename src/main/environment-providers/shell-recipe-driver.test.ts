import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { encodePairingOffer } from '../../shared/remote-runtime/pairing/pairing'
import { PAIRING_OFFER_VERSION } from '../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import type { OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'
import { runEnvironmentProviderDriverContract } from './environment-provider-driver-contract.test-support'
import { ShellRecipeDriver } from './shell-recipe-driver'

const tmpRoots: string[] = []

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

// A recipe whose "VMs" are files in a state dir, so the contract can see what destroy left behind.
function makeFileBackedRecipe(): { repoPath: string; stateDir: string; recipe: OrcaVmRecipe } {
  const repoPath = mkdtempSync(join(tmpdir(), 'orca-shell-recipe-driver-'))
  tmpRoots.push(repoPath)
  const stateDir = join(repoPath, 'vms')
  mkdirSync(stateDir)
  const pairingCode = encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint: 'wss://vm.example.com',
    deviceToken: 'token',
    publicKeyB64: 'public-key'
  })
  const vmFile = `require('node:path').join(${JSON.stringify(stateDir)}, process.env.ORCA_VM_INSTANCE_ID)`
  const printResult = `console.log(JSON.stringify({ schemaVersion: 1, pairingCode: ${JSON.stringify(pairingCode)}, projectRoot: '/workspace/repo' }))`
  const scripts = {
    create: `require('node:fs').writeFileSync(${vmFile}, 'running'); ${printResult}`,
    suspend: `require('node:fs').writeFileSync(${vmFile}, 'suspended')`,
    // Like a real provider: a destroyed VM cannot be woken.
    resume: `const fs = require('node:fs'); if (!fs.existsSync(${vmFile})) process.exit(1); fs.writeFileSync(${vmFile}, 'running'); ${printResult}`,
    destroy: `require('node:fs').rmSync(${vmFile}, { force: true })`
  }
  const commands = Object.fromEntries(
    Object.entries(scripts).map(([mode, source]) => {
      const scriptPath = join(repoPath, `${mode}.js`)
      writeFileSync(scriptPath, source)
      return [mode, `"${process.execPath}" "${scriptPath}"`]
    })
  )
  return {
    repoPath,
    stateDir,
    recipe: {
      id: 'file-backed',
      name: 'File-backed VM',
      create: commands.create,
      suspend: commands.suspend,
      resume: commands.resume,
      destroy: commands.destroy
    }
  }
}

runEnvironmentProviderDriverContract('ShellRecipeDriver', async () => {
  const { repoPath, stateDir, recipe } = makeFileBackedRecipe()
  return {
    driver: new ShellRecipeDriver(recipe, repoPath),
    liveEnvironmentIds: async () => readdirSync(stateDir),
    reopenDriver: () => new ShellRecipeDriver(recipe, repoPath)
  }
})
