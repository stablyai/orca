// Bump by one in any change that fixes a cell crash or a cell safety bug. Every runtime
// metrics line carries it, and an alert pages on a serving cell that reports a level below
// the fixed floor `relay_cell_min_fix_level` (production.tfvars) for 6 hours; raise the floor
// once every serving cell runs the new level. Images from before this constant report nothing,
// which the alert reads as below.
export const RELAY_FIX_LEVEL = 2
