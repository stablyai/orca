import { DEFAULT_TERMINAL_THEME } from '../../terminal-webview-html/theme'
import { terminalBundledFontCss } from '../../fonts/terminal-bundled-font-css'
import {
  terminalBoldWeight,
  terminalFontFamilyCss,
  type TerminalFontId,
  type TerminalFontStyle
} from '../terminal-font-style'
import { terminalFontPxForScale } from '../terminal-text-scales'

export type TerminalFontPreviewLook = {
  family: string
  px: number
  lineHeight: number
  weight: number
  bold: number
}

export function terminalFontPreviewLook(
  textScale: number,
  style: TerminalFontStyle,
  ios: boolean
): TerminalFontPreviewLook {
  return {
    family: terminalFontFamilyCss(style.font, ios),
    px: terminalFontPxForScale(textScale),
    lineHeight: style.lineHeight,
    weight: style.weight,
    bold: terminalBoldWeight(style.weight)
  }
}

const theme = DEFAULT_TERMINAL_THEME

// A Claude Code turn: prompt, tool rows, a rule and the input box, so weight and spacing show on real shapes.
const SAMPLE_LINES = [
  '<i class="g">➜</i> <i class="b">~/orca</i> <i class="m">main</i> <i class="d">❯</i> claude',
  '<b class="y">✻</b> <b>Claude Code</b>  <i class="d">~/orca/mobile</i>',
  '',
  '<i class="g">●</i> Read <b>src/terminal/text-scaling.ts</b>',
  '<i class="g">●</i> Bash(pnpm test resume --maxWorkers=2)',
  '  <i class="d">⎿</i>  <i class="g">✓</i> 42 passed <i class="d">(1.8s)</i>  <i class="r">0 failed</i>',
  '<i class="d">────────────────────────────────────────────────────────────</i>',
  '<i class="d">❯</i> fix the flaky resume test<i class="cur"> </i>',
  '<i class="d">  ⏵⏵ accept edits on · 12% context left</i>'
]

// Sizes cells the way xterm does: canvas metrics for 'W', floored to device pixels, height times the line spacing.
const SCRIPT = `
function measure(look) {
  var pre = document.getElementById('t');
  var ctx = document.createElement('canvas').getContext('2d');
  ctx.font = look.px + 'px ' + look.family;
  var metrics = ctx.measureText('W');
  var height = (metrics.fontBoundingBoxAscent || 0) + (metrics.fontBoundingBoxDescent || 0) || look.px * 1.2;
  var ratio = window.devicePixelRatio || 1;
  var cellWidth = Math.floor(metrics.width * ratio) / ratio;
  pre.style.lineHeight = Math.floor(Math.ceil(height * ratio) * look.lineHeight) / ratio + 'px';
  if (window.ReactNativeWebView && cellWidth > 0) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ cellWidth: cellWidth }));
  }
}
window.__orcaPreview = function (look) {
  var root = document.documentElement.style;
  root.setProperty('--f', look.family);
  root.setProperty('--s', look.px + 'px');
  root.setProperty('--w', String(look.weight));
  root.setProperty('--bw', String(look.bold));
  var done = function () { measure(look); };
  if (document.fonts && document.fonts.load) {
    document.fonts.load(look.weight + ' ' + look.px + 'px ' + look.family).then(done, done);
  } else {
    done();
  }
};
`

/** A static terminal sample in the picked font; the native app inlines only that font's file. */
export function terminalFontPreviewHtml(font: TerminalFontId, look: TerminalFontPreviewLook) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<style>${terminalBundledFontCss(font) ?? ''}</style>
<style>
html,body{margin:0;height:100%;overflow:hidden;background:${theme.background};-webkit-text-size-adjust:100%}
pre{margin:0;padding:10px 12px;color:${theme.foreground};white-space:pre;font-family:var(--f);font-size:var(--s);font-weight:var(--w)}
b{font-weight:var(--bw)}i{font-style:normal}
.g{color:${theme.green}}.b{color:${theme.blue}}.m{color:${theme.magenta}}.y{color:${theme.yellow}}.r{color:${theme.red}}.d{color:${theme.brightBlack}}
.cur{background:${theme.cursor}}
</style></head>
<body><pre id="t">${SAMPLE_LINES.join('\n')}</pre>
<script>${SCRIPT}
window.__orcaPreview(${JSON.stringify(look).replace(/</g, '\\u003c')});
</script></body></html>`
}
