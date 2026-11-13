import { drawing } from '@kit.ArkGraphics2D';

const filters: Map<string, drawing.ColorFilter> = new Map();

// Tint the rendered alpha mask; SVG fillColor would fill Lucide's hollow paths.
export function lucideColorFilter(color: string): drawing.ColorFilter {
  let held = filters.get(color);
  if (held) { return held; }
  let rgb = /^#[0-9a-fA-F]{6}$/.test(color) ? Number.parseInt(color.substring(1), 16) : 0;
  let filter = drawing.ColorFilter.createBlendModeColorFilter(0xff000000 + rgb, drawing.BlendMode.SRC_IN);
  filters.set(color, filter);
  return filter;
}
