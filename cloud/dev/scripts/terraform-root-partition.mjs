#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Why: the relay Terraform root is being carved into foundation / relay / apps. Until every
// family is assigned to exactly one root per environment, a state move can silently orphan or
// double-manage a resource. This file is the single authority; the test pins it to the .tf files.

export const ROOTS = ['foundation', 'apps', 'relay']
export const ENVIRONMENTS = ['production', 'staging']

// Each root is its own Terraform directory; a family is declared in exactly the roots that own
// it somewhere, so the directory is the authority the fixture is checked against. Only the relay
// directory ships here, so only relay declarations can be read back; the partition still names
// all three roots because it is the authority for the whole carve.
export const ROOT_DIRECTORIES = {
  relay: 'infra/terraform/'
}

export const DECLARING_ROOTS = Object.keys(ROOT_DIRECTORIES)

export const fixturePath = fileURLToPath(
  new URL('../fixtures/terraform-root-partition/families.json', import.meta.url)
)

function rootDirectory(root) {
  const relative = ROOT_DIRECTORIES[root]
  if (!relative) throw new Error(`unknown root ${root}`)
  return fileURLToPath(new URL(`../../${relative}`, import.meta.url))
}

export function declaredFamilies(root = 'relay') {
  const directory = rootDirectory(root)
  const families = new Map()
  for (const entry of readdirSync(directory).filter((name) => name.endsWith('.tf')).sort()) {
    const text = readFileSync(`${directory}${entry}`, 'utf8')
    for (const match of text.matchAll(/^resource "([a-z0-9_]+)" "([a-z0-9_]+)"/gm)) {
      const address = `${match[1]}.${match[2]}`
      if (families.has(address)) throw new Error(`duplicate declaration ${address}`)
      families.set(address, entry)
    }
  }
  return families
}

// A family may be declared in two roots at once (the environment-conditional ten), so ownership
// is per (root, environment) while declaration is per root.
export function declaredRootFamilies(root) {
  return new Set(declaredFamilies(root).keys())
}

export function ownedRootFamilies(partition, root) {
  const families = new Set(partition[root])
  for (const [family, owners] of Object.entries(partition.env_conditional)) {
    if (Object.values(owners).includes(root)) families.add(family)
  }
  return families
}

export function readPartition(path = fixturePath) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// Family address for a state entry: strips [index] / ["key"] and ignores data sources.
export function familyOf(stateAddress) {
  return stateAddress.replace(/\[.*$/, '')
}

export function rootFor(partition, family, environment) {
  if (!ENVIRONMENTS.includes(environment)) throw new Error(`unknown environment ${environment}`)
  const conditional = partition.env_conditional[family]
  if (conditional) return conditional[environment]
  for (const root of ROOTS) if (partition[root].includes(family)) return root
  return undefined
}

export function expectedRootFamilies(partition, root, environment) {
  const families = new Set(partition[root])
  for (const [family, owners] of Object.entries(partition.env_conditional)) {
    if (owners[environment] === root) families.add(family)
  }
  return families
}

// Compares `terraform state list` output for one root against the partition.
export function auditStateList(partition, root, environment, stateList) {
  const expected = expectedRootFamilies(partition, root, environment)
  const orphans = new Set(partition.state_orphans[environment] ?? [])
  const unexpected = []
  const seen = new Set()
  for (const line of stateList.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    if (orphans.has(line)) continue
    if (line.startsWith('data.')) continue
    const family = familyOf(line)
    seen.add(family)
    if (!expected.has(family)) unexpected.push(line)
  }
  return { unexpected, seen: [...seen].sort() }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, root, environment, stateFile] = process.argv.slice(2)
  const partition = readPartition()
  if (command === 'audit') {
    const { unexpected } = auditStateList(partition, root, environment, readFileSync(stateFile, 'utf8'))
    if (unexpected.length > 0) {
      process.stderr.write(`entries in ${root}/${environment} state outside its partition:\n`)
      for (const line of unexpected) process.stderr.write(`  ${line}\n`)
      process.exitCode = 1
    } else {
      process.stdout.write(`${root}/${environment}: state matches partition\n`)
    }
  } else if (command === 'list') {
    for (const family of [...expectedRootFamilies(partition, root, environment)].sort()) {
      process.stdout.write(`${family}\n`)
    }
  } else if (command === 'write-families') {
    // Refreshes only the declared-family lists; ownership edits stay manual.
    for (const name of DECLARING_ROOTS) {
      for (const family of declaredRootFamilies(name)) {
        if (rootFor(partition, family, 'production') === undefined) {
          throw new Error(`unassigned family ${family}; add it to the fixture first`)
        }
      }
    }
    writeFileSync(fixturePath, `${JSON.stringify(partition, null, 2)}\n`)
  } else {
    process.stderr.write('usage: terraform-root-partition.mjs audit|list <root> <environment> [state-list-file]\n')
    process.exitCode = 2
  }
}
