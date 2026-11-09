import { display, window } from '@kit.ArkUI';

export interface WindowRegion { x: number; y: number; width: number; height: number; }
export interface FoldDivision { axis: string; start: number; end: number; }
export interface WindowRegions { occlusions: WindowRegion[]; creases: WindowRegion[]; }
export interface PageRegions { occlusions: WindowRegion[]; division: FoldDivision | null; }

function usable(rect: WindowRegion): boolean {
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
}

/** Intersect screen reservations with the measured WebView, in page coordinates. */
export function projectPageRegions(regions: WindowRegions, frame: WindowRegion): PageRegions {
  let occlusions: WindowRegion[] = [];
  let division: FoldDivision | null = null;
  if (!usable(frame)) { return { occlusions: occlusions, division: division }; }
  for (let region of regions.occlusions) {
    if (!usable(region) || occlusions.length >= 16) { continue; }
    let x = Math.max(0, region.x - frame.x); let y = Math.max(0, region.y - frame.y);
    let right = Math.min(frame.width, region.x + region.width - frame.x);
    let bottom = Math.min(frame.height, region.y + region.height - frame.y);
    if (right > x && bottom > y) {
      occlusions.push({ x: x, y: y, width: right - x, height: bottom - y });
    }
  }
  for (let region of regions.creases) {
    if (!usable(region)) { continue; }
    let vertical = region.height >= region.width;
    let crossStart = vertical ? region.y - frame.y : region.x - frame.x;
    let crossEnd = crossStart + (vertical ? region.height : region.width);
    if (crossStart > 0 || crossEnd < (vertical ? frame.height : frame.width)) { continue; }
    let start = vertical ? region.x - frame.x : region.y - frame.y;
    let end = start + (vertical ? region.width : region.height);
    if (start <= 0 || end >= (vertical ? frame.width : frame.height)) { continue; }
    // The shared layout represents a single split. Two crossing hinges are ambiguous.
    if (division) { division = null; break; }
    division = { axis: vertical ? 'vertical' : 'horizontal', start: start, end: end };
  }
  return { occlusions: occlusions, division: division };
}

function readCreases(screen: display.Display): display.Rect[] {
  if (!display.isFoldable()) { return []; }
  let status = display.getFoldStatus();
  if (status !== display.FoldStatus.FOLD_STATUS_HALF_FOLDED
    && status !== display.FoldStatus.FOLD_STATUS_EXPANDED_WITH_SECOND_HALF_FOLDED
    && status !== display.FoldStatus.FOLD_STATUS_FOLDED_WITH_SECOND_HALF_FOLDED
    && status !== display.FoldStatus.FOLD_STATUS_HALF_FOLDED_WITH_SECOND_HALF_FOLDED
    && status !== display.FoldStatus.FOLD_STATUS_HALF_FOLDED_WITH_SECOND_EXPANDED) { return []; }
  try {
    let live = screen.getLiveCreaseRegion();
    if (live) { return live.displayId === screen.id ? live.creaseRects : []; }
  } catch (e) {}
  let fallback = display.getCurrentFoldCreaseRegion();
  return fallback?.displayId === screen.id && fallback.creaseRects.length === 1 ? fallback.creaseRects : [];
}

/** Observe the ability's window once, including posture changes without a resize. */
export class ShellWindowRegions {
  private current: window.Window;
  private epoch: number = 0;
  private closed: boolean = false;
  private foldable: boolean = false;
  private onChange = (): void => { this.refresh(); };

  constructor(current: window.Window) { this.current = current; }

  start(): void {
    try { display.on('change', this.onChange); } catch (e) {}
    try { this.current.on('windowRectChange', this.onChange); } catch (e) {}
    try { this.current.on('displayIdChange', this.onChange); } catch (e) {}
    try {
      this.foldable = display.isFoldable();
      if (this.foldable) {
        display.on('foldStatusChange', this.onChange);
        display.on('foldDisplayModeChange', this.onChange);
      }
    } catch (e) {}
    this.refresh();
  }

  dispose(): void {
    this.closed = true; this.epoch++;
    try { display.off('change', this.onChange); } catch (e) {}
    try { this.current.off('windowRectChange', this.onChange); } catch (e) {}
    try { this.current.off('displayIdChange', this.onChange); } catch (e) {}
    if (this.foldable) {
      try { display.off('foldStatusChange', this.onChange); } catch (e) {}
      try { display.off('foldDisplayModeChange', this.onChange); } catch (e) {}
    }
    AppStorage.setOrCreate('shellWindowRegions', '');
  }

  refresh(): void {
    if (this.closed) { return; }
    let epoch = ++this.epoch;
    this.read().then((regions: WindowRegions): void => {
      if (epoch !== this.epoch) { return; }
      AppStorage.setOrCreate('shellWindowRegions', JSON.stringify(regions));
    }).catch((): void => {
      if (epoch === this.epoch) { AppStorage.setOrCreate('shellWindowRegions', ''); }
    });
  }

  private async read(): Promise<WindowRegions> {
    let props = this.current.getWindowProperties();
    let origin = display.convertGlobalToRelativeCoordinate(
      { x: props.windowRect.left, y: props.windowRect.top }, props.displayId);
    let screen = display.getDisplayByIdSync(origin.displayId);
    let context = this.current.getUIContext();
    let toWindow = (rect: display.Rect): WindowRegion => ({
      x: context.px2vp(rect.left - origin.position.x),
      y: context.px2vp(rect.top - origin.position.y),
      width: context.px2vp(rect.width),
      height: context.px2vp(rect.height)
    });
    let occlusions: WindowRegion[] = []; let creases: WindowRegion[] = [];
    try { creases = readCreases(screen).map(toWindow).filter(usable); } catch (e) {}
    try {
      let cutout = await screen.getCutoutInfo();
      let edge = cutout.waterfallDisplayAreaRects;
      let bounds = edge ? cutout.boundingRects.concat([edge.left, edge.right, edge.top, edge.bottom]) : cutout.boundingRects;
      occlusions = bounds.map(toWindow).filter(usable);
    } catch (e) {}
    return { occlusions: occlusions, creases: creases };
  }
}
