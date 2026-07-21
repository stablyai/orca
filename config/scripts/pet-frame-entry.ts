// Bundle entry for build-pet-frame-manifest.mjs — re-exports the shared
// detection + chroma key so the script runs the renderer's exact logic rather
// than a copy of it.
export { detectFramesFromImageData } from '../../src/shared/sprite-frame-detection'
export { keyMagenta } from '../../src/shared/pet-chroma-key'
