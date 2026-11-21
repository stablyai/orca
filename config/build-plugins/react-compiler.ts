import type { Options } from '@vitejs/plugin-react'
import { reactCompilerExcludedFiles } from './react-compiler-uncompiled-files.mjs'

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
