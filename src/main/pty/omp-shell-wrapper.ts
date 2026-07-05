// Why: shared PowerShell bootstrap code cannot import from src/main; keep this
// facade so existing main imports/tests do not need to move in the same change.
export * from '../../shared/omp-shell-wrapper'
