import {
  isComponentFixture,
  type ComponentFixture,
  type ComponentFixtureModule
} from './component-fixture'

// Lazy-load fixtures so one screenshot does not transform every component graph.
const fixtureModuleLoaders = import.meta.glob<ComponentFixtureModule>('../**/*.fixture.tsx')

export type ComponentFixtureEntry = {
  id: string
  file: string
  fixture: ComponentFixture
}

function fixtureFileToComponentId(file: string): string {
  return file
    .replace(/^\.\.\//, '')
    .replace(/^components\//, '')
    .replace(/\.fixture\.tsx$/, '')
}

function componentIdToFixtureFile(componentId: string): string | null {
  return (
    Object.keys(fixtureModuleLoaders).find(
      (file) => fixtureFileToComponentId(file) === componentId
    ) ?? null
  )
}

function collectFixtures(file: string, module: ComponentFixtureModule): ComponentFixtureEntry[] {
  const componentId = fixtureFileToComponentId(file)
  return Object.entries(module).flatMap(([name, value]) =>
    isComponentFixture(value)
      ? [
          {
            id: `${componentId}:${name}`,
            file: `src/renderer/src/${file.slice(3)}`,
            fixture: value
          }
        ]
      : []
  )
}

export async function listComponentFixtures(): Promise<ComponentFixtureEntry[]> {
  const groups = await Promise.all(
    Object.entries(fixtureModuleLoaders).map(async ([file, load]) =>
      collectFixtures(file, await load())
    )
  )
  return groups.flat().sort((left, right) => left.id.localeCompare(right.id))
}

export async function loadComponentFixture(id: string): Promise<ComponentFixtureEntry> {
  const separator = id.lastIndexOf(':')
  const componentId = separator === -1 ? id : id.slice(0, separator)
  const file = componentIdToFixtureFile(componentId)
  if (!file) {
    throw new Error(`No fixture file for "${componentId}" (expected ${componentId}.fixture.tsx).`)
  }
  const entries = collectFixtures(file, await fixtureModuleLoaders[file]())
  const entry = separator === -1 ? entries[0] : entries.find((candidate) => candidate.id === id)
  if (!entry) {
    const known = entries.map((candidate) => candidate.id).join(', ')
    throw new Error(`Unknown fixture "${id}". Known in this file: ${known || 'none'}.`)
  }
  return entry
}
