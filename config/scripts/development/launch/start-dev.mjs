import './dev-launch-owner.mjs'
import { prepareDevRuntime } from './prepare-dev-runtime.mjs'

prepareDevRuntime()
await import('./run-electron-vite-dev.mjs')
