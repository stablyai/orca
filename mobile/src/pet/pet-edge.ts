// Edge geometry is a SHARED rule, not a per-surface constant.
//
// This file used to carry its own copy of EDGE_THRESHOLD "mirroring the
// desktop's". It did mirror the desktop — but neither mirrored entryPointFor,
// which landed arriving pets at exactly 0 or 1, i.e. inside the threshold. Two
// surfaces agreeing with each other while disagreeing with the rules module is
// how the handoff loop survived a fix aimed at it.
//
// Re-exported rather than deleted so mobile call sites keep reading naturally.
export { edgeAtNormalized } from '../../../src/shared/pet-presence'
