export { segmentsOverlap } from './segment-glob-overlap.ts';
export { parsePatternSegments, patternsOverlap } from './path-pattern-overlap.ts';
export { scopesOverlap, type ScopeOverlapResult } from './scope-overlap.ts';
export {
  selectDispatchable,
  type CandidateTask,
  type ActiveTask,
  type DeferredTask,
  type DispatchSelectionResult,
} from './dispatch-selection.ts';
