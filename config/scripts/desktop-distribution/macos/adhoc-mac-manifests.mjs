import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

function expectedNames(arch, version) {
  if (!['arm64', 'x64'].includes(arch) || !/^[0-9][0-9A-Za-z.+-]*$/.test(version)) {
    throw new Error('Invalid Mac architecture or version')
  }
  return [`Orca-${version}${arch === 'arm64' ? '-arm64' : ''}-mac.zip`, `orca-macos-${arch}.dmg`]
}

export function validateManifest(manifest, arch, version) {
  const names = expectedNames(arch, version)
  if (
    manifest.version !== version ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== 2
  ) {
    throw new Error(`Incomplete or mismatched ${arch} updater manifest`)
  }
  for (const name of names) {
    const matches = manifest.files.filter((file) => file.url === name)
    if (
      matches.length !== 1 ||
      !Number.isSafeInteger(matches[0].size) ||
      matches[0].size <= 0 ||
      !/^[A-Za-z0-9+/]{86}==$/.test(matches[0].sha512)
    ) {
      throw new Error(`Invalid updater entry: ${name}`)
    }
  }
  return names
}

async function checksum(path) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return hash.digest('base64')
}

export async function stageManifest(manifest, arch, version, directory) {
  const names = validateManifest(manifest, arch, version)
  const assets = []
  for (const name of names) {
    const entry = manifest.files.find((file) => file.url === name)
    if (
      (await stat(join(directory, name))).size !== entry.size ||
      (await checksum(join(directory, name))) !== entry.sha512
    ) {
      throw new Error(`Updater checksum or size mismatch: ${name}`)
    }
    assets.push({ name, size: entry.size })
    const blockmap = `${name}.blockmap`
    // Both archive types need their matching differential-update sidecar.
    assets.push({ name: blockmap, size: (await stat(join(directory, blockmap))).size })
  }
  return { arch, manifest, assets }
}

export function mergeManifests(records, version, uploaded) {
  if (records.length !== 2 || new Set(records.map((record) => record.arch)).size !== 2) {
    throw new Error('Both Mac architectures are required')
  }
  for (const arch of ['arm64', 'x64']) {
    const record = records.find((item) => item.arch === arch)
    if (!record) {
      throw new Error(`Missing ${arch} manifest`)
    }
    const names = validateManifest(record.manifest, arch, version)
    const required = names.flatMap((name) => [name, `${name}.blockmap`])
    if (record.assets.length !== required.length) {
      throw new Error('Incomplete staged assets')
    }
    for (const name of required) {
      const local = record.assets.filter((asset) => asset.name === name)
      const remote = uploaded.filter((asset) => asset.name === name)
      if (
        local.length !== 1 ||
        remote.length !== 1 ||
        !Number.isSafeInteger(local[0].size) ||
        local[0].size <= 0 ||
        local[0].size !== remote[0].size
      ) {
        throw new Error(`Missing or mismatched uploaded asset: ${name}`)
      }
    }
  }
  const arm = records.find((record) => record.arch === 'arm64').manifest
  const intel = records.find((record) => record.arch === 'x64').manifest
  const canonical = arm.files.find((file) => file.url.endsWith('.zip'))
  return {
    ...arm,
    files: [...arm.files, ...intel.files],
    path: canonical.url,
    sha512: canonical.sha512
  }
}

async function main([mode, first, second, third, fourth]) {
  if (mode === 'stage') {
    const { parse } = await import('yaml')
    const manifest = parse(await readFile(join(third, 'latest-mac.yml'), 'utf8'))
    const record = await stageManifest(manifest, first, second, third)
    await mkdir(fourth, { recursive: true })
    await writeFile(join(fourth, `${first}.json`), JSON.stringify(record))
    await writeFile(
      join(fourth, `${first}-assets.txt`),
      `${record.assets.map((asset) => asset.name).join('\n')}\n`
    )
  } else if (mode === 'merge') {
    const records = await Promise.all(
      ['arm64', 'x64'].map(async (arch) =>
        JSON.parse(await readFile(join(second, `${arch}.json`), 'utf8'))
      )
    )
    const { assets } = JSON.parse(await readFile(join(second, 'assets.json'), 'utf8'))
    // JSON is YAML 1.2 and preserves every updater metadata field without another dependency.
    await writeFile(
      join(second, 'latest-mac.yml'),
      `${JSON.stringify(mergeManifests(records, first, assets), null, 2)}\n`
    )
  } else {
    throw new Error('Expected stage or merge')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
