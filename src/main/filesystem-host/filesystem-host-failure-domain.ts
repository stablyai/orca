import { resolve, sep, win32 } from 'node:path'
import { createHash } from 'node:crypto'

export type FilesystemExecutionHost = 'native' | 'windows-host'

type Mapping = {
  executionHost: FilesystemExecutionHost
  prefix: string
  mountId: string
}

function normalize(executionHost: FilesystemExecutionHost, value: string): string {
  const normalized = executionHost === 'windows-host' ? win32.resolve(value) : resolve(value)
  return executionHost === 'windows-host' ? normalized.toLowerCase() : normalized
}

function containsPath(
  executionHost: FilesystemExecutionHost,
  prefix: string,
  value: string
): boolean {
  const separator = executionHost === 'windows-host' ? win32.sep : sep
  return (
    value === prefix ||
    value.startsWith(prefix.endsWith(separator) ? prefix : `${prefix}${separator}`)
  )
}

export class FilesystemFailureDomainRegistry {
  private mappings: Mapping[] = []

  publish(mapping: Mapping): string[] {
    const normalized = normalize(mapping.executionHost, mapping.prefix)
    const replaced = this.mappings.filter(
      (candidate) =>
        candidate.executionHost === mapping.executionHost && candidate.prefix === normalized
    )
    this.mappings = [
      ...this.mappings.filter(
        (candidate) =>
          candidate.executionHost !== mapping.executionHost || candidate.prefix !== normalized
      ),
      { ...mapping, prefix: normalized }
    ].sort((left, right) => right.prefix.length - left.prefix.length)
    return this.orphanedLaneKeys(replaced)
  }

  remove(input: Pick<Mapping, 'executionHost' | 'prefix'>): string[] {
    const normalized = normalize(input.executionHost, input.prefix)
    const removed = this.mappings.filter(
      (mapping) => mapping.executionHost === input.executionHost && mapping.prefix === normalized
    )
    this.mappings = this.mappings.filter(
      (mapping) => mapping.executionHost !== input.executionHost || mapping.prefix !== normalized
    )
    return this.orphanedLaneKeys(removed)
  }

  resolve(executionHost: FilesystemExecutionHost, path: string): string {
    const normalized = normalize(executionHost, path)
    const mapping = this.mappings.find(
      (candidate) =>
        candidate.executionHost === executionHost &&
        containsPath(executionHost, candidate.prefix, normalized)
    )
    return `${executionHost}:${mapping?.mountId ?? 'unknown'}`
  }

  classificationLane(executionHost: FilesystemExecutionHost, path: string): string {
    const normalized = normalize(executionHost, path)
    const digest = createHash('sha256').update(normalized).digest('hex')
    return `${executionHost}:classify:${digest}`
  }

  clearHost(executionHost: FilesystemExecutionHost): void {
    this.mappings = this.mappings.filter((mapping) => mapping.executionHost !== executionHost)
  }

  private orphanedLaneKeys(candidates: readonly Mapping[]): string[] {
    return [
      ...new Set(
        candidates
          .filter(
            (candidate) =>
              !this.mappings.some(
                (mapping) =>
                  mapping.executionHost === candidate.executionHost &&
                  mapping.mountId === candidate.mountId
              )
          )
          .map((candidate) => `${candidate.executionHost}:${candidate.mountId}`)
      )
    ]
  }
}
