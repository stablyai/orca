#!/usr/bin/env node
// Build entry/src/main/resources/rawfile/spike/xterm.html by inlining the vendored
// @xterm/xterm + @xterm/addon-webgl UMD bundles (same versions as upstream Orca mobile).
// Run: node tools/build-spike-xterm.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const xtermJs = read('tools/vendor/xterm/xterm.js')
const xtermCss = read('tools/vendor/xterm/xterm.css')
const webglJs = read('tools/vendor/xterm-webgl/addon-webgl.js')

// Keep this script ES5-safe and free of backticks so it survives template inlining.
const init = `
(function () {
  'use strict';
  var status = {
    ua: navigator.userAgent,
    terminal: 'missing',
    webgl: 'pending',
    webglError: '',
    rows: 0,
    cols: 0,
    keys: 0,
    writes: 0,
    errors: [],
    finished: false
  };
  window.__spikeStatus = status;
  function report() {
    try {
      if (window.orcaSpike && window.orcaSpike.report) {
        window.orcaSpike.report(JSON.stringify(status));
      }
    } catch (e) { /* bridge not ready yet */ }
  }
  window.addEventListener('error', function (ev) {
    status.errors.push(String(ev.message || ev));
    report();
  });

  function TerminalCtor() {
    if (typeof Terminal === 'function') return Terminal;
    return null;
  }

  var T = TerminalCtor();
  if (!T) {
    status.terminal = 'missing';
    status.finished = true;
    report();
    return;
  }
  status.terminal = 'loaded';

  var term = null;
  try {
    term = new T({
      rows: 24,
      cols: 80,
      cursorBlink: true,
      fontFamily: '"Menlo", "Cascadia Mono", monospace',
      fontSize: 14,
      theme: {
        background: '#111111',
        foreground: '#e8e8e8',
        cursor: '#e8e8e8'
      }
    });
    window.__term = term;
    term.open(document.getElementById('term'));
  } catch (e) {
    status.errors.push('open: ' + String(e && e.message || e));
    status.finished = true;
    report();
    return;
  }
  status.rows = term.rows;
  status.cols = term.cols;

  try {
    var NS = window.WebglAddon;
    var Ctor = null;
    if (NS && typeof NS.WebglAddon === 'function') Ctor = NS.WebglAddon;
    else if (typeof NS === 'function') Ctor = NS;
    if (!Ctor) throw new Error('webgl addon constructor not found');
    var addon = new Ctor();
    if (addon.onContextLoss) {
      addon.onContextLoss(function () {
        status.webgl = 'context-lost';
        report();
      });
    }
    term.loadAddon(addon);
    status.webgl = 'loaded';
  } catch (e) {
    status.webgl = 'failed';
    status.webglError = String(e && e.message || e);
  }

  term.onData(function (d) {
    status.keys++;
    term.write(d);
    if (status.keys % 8 === 0) report();
  });

  function banner() {
    term.writeln('\\x1b[36mOrca HarmonyOS spike \\u00b7 ArkWeb xterm\\x1b[0m');
    term.writeln('webgl: ' + status.webgl + (status.webglError ? (' (' + status.webglError + ')') : ''));
    term.writeln('ua: ' + navigator.userAgent);
    term.writeln('');
    term.writeln('Type here to test keyboard echo. 256-color test:');
    var line = '';
    for (var i = 0; i < 8; i++) {
      for (var j = 0; j < 24; j++) {
        line += '\\x1b[38;5;' + (i * 24 + j + 16) + 'm\\u2588\\x1b[0m';
      }
      term.writeln(line);
      line = '';
    }
    term.writeln('');
    term.writeln('\\x1b[32m$ \\x1b[0m');
  }
  try {
    banner();
    status.writes++;
  } catch (e) {
    status.errors.push('banner: ' + String(e && e.message || e));
  }

  var btn = document.getElementById('demo');
  if (btn) {
    btn.addEventListener('click', function () {
      status.keys += 1;
      term.write('echo spike-demo\\r\\n');
      term.writeln('spike-demo output line ' + new Date().toISOString());
    });
  }

  status.finished = true;
  report();
  setTimeout(report, 1500);
  setTimeout(report, 4000);
})();
`

const html =
  `<!DOCTYPE html>\n<html>\n<head>\n` +
  `<meta charset="utf-8" />\n` +
  `<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />\n` +
  `<style>\n${xtermCss}\n</style>\n` +
  `<style>\n` +
  `html,body{margin:0;padding:0;background:#111111;height:100%;overflow:hidden;}\n` +
  `#bar{color:#9a9a9a;font:12px -apple-system,system-ui,sans-serif;padding:6px 10px;display:flex;gap:10px;align-items:center;}\n` +
  `#term{padding:4px 8px;height:calc(100% - 46px);}\n` +
  `#demo{background:#2a2a2a;color:#e8e8e8;border:1px solid #3a3a3a;border-radius:6px;padding:2px 10px;font:12px system-ui;}\n` +
  `</style>\n</head>\n<body>\n` +
  `<div id="bar"><span id="indicator">init\u2026</span><button id="demo">type demo</button></div>\n` +
  `<div id="term"></div>\n` +
  `<script>\n${xtermJs}\n</script>\n` +
  `<script>\n${webglJs}\n</script>\n` +
  `<script>\n${init}\n</script>\n` +
  `</body>\n</html>\n`

const out = 'entry/src/main/resources/rawfile/spike/xterm.html'
writeFileSync(join(root, out), html)
console.log('wrote', out, html.length, 'bytes')
