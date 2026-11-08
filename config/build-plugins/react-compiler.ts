import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Options } from '@vitejs/plugin-react'

// Hand-kept list plus every file still in a hazard ratchet; compiled, these would run differently.
const UNCOMPILED_FILE_LISTS = [
  'config/react-compiler-uncompiled-files.txt',
  'config/render-path-translate-baseline.txt',
  'config/react-compiler-hazard-baseline.txt'
]

function listedFiles(list: string): string[] {
  return readFileSync(resolve(list), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.replace(/^\d+\s+/, '').split('#')[0])
}

export function reactCompilerExcludedFiles(): string[] {
  return [...new Set(UNCOMPILED_FILE_LISTS.flatMap(listedFiles))]
}

export function isReactCompilerEnabled(): boolean {
  return process.env.ORCA_REACT_COMPILER !== '0'
}

export const REACT_COMPILER_OPTIONS = { target: '19' } as const

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function reactCompilerExcludePattern(): RegExp {
  return new RegExp(`/(?:${reactCompilerExcludedFiles().map(escapeRegExp).join('|')})$`)
}

// ORCA_REACT_COMPILER=0 builds without the compiler for bisecting.
export function reactPluginOptions(): Options {
  if (!isReactCompilerEnabled()) {
    return {}
  }
  return {
    compiler: REACT_COMPILER_OPTIONS,
    exclude: [/\/node_modules\//, reactCompilerExcludePattern()]
  }
}
