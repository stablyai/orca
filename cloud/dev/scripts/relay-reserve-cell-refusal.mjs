// Step 5: the director refuses per-cell admin reads for a reserve cell with exactly this body;
// any other 404 stays a failure.
export const RESERVE_CELL_REFUSAL_ERROR = 'cell_in_reserve_mode'

export function isReserveCellRefusal(status, body) {
  return status === 404 && body?.error === RESERVE_CELL_REFUSAL_ERROR
}

// Step-5 design default 4: a reserve cell is flipped back to db before a roll.
export function reserveCellRollRefusal(cellId) {
  return new Error(
    `${cellId ?? 'a cell this step reads'} is in reserve mode ` +
      `(${RESERVE_CELL_REFUSAL_ERROR}): flip it to admitMode=db with the cell-flags ` +
      'workflow and wait for it to record db before rolling it, then flip it back to reserve'
  )
}
