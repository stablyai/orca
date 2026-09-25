export interface FleetStateMarker {
  readonly dispatch: string;
  readonly iteration: number;
  readonly worktree: string;
}

const STATE_PATTERN = /<!-- orca-fleet:state (\{.*?\}) -->/;

/**
 * Marker để Fleet khôi phục sau restart (blueprint §3.3). `>` được escape thành `>` để giá trị
 * chứa `-->` không đóng comment HTML sớm; `JSON.parse` đọc ngược lại bình thường.
 */
export function renderStateMarker(state: FleetStateMarker): string {
  const json = JSON.stringify(state).replaceAll('>', '\\u003e');
  return `<!-- orca-fleet:state ${json} -->`;
}

export function parseStateMarker(body: string): FleetStateMarker | undefined {
  const raw = STATE_PATTERN.exec(body)?.[1];
  if (raw === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const { dispatch, iteration, worktree } = parsed as Record<string, unknown>;
    if (typeof dispatch === 'string' && typeof worktree === 'string' && Number.isInteger(iteration)) {
      return { dispatch, iteration: iteration as number, worktree };
    }
  } catch {
    // Marker hỏng (bị người sửa tay): coi như không có, để Fleet đánh dấu issue cần xem thay vì đoán.
  }
  return undefined;
}
