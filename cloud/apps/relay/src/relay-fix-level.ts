// Bump for cell crash/safety fixes; runtime metrics carry the level and page after 6h below relay_cell_min_fix_level (missing also counts below).
// Raise the production.tfvars floor only after every serving cell upgrades.
export const RELAY_FIX_LEVEL = 2
