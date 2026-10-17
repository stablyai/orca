/**
 * A page that shows SVG source as an image, for the HTML preview's WebView.
 *
 * Why `<img>` rather than inlining the markup: an image context never runs the file's scripts or
 * loads its external references, and WebKit still draws everything react-native-svg would not.
 */
export function svgPreviewDocument(svg: string): string {
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=8">',
    '<style>html,body{margin:0;height:100%;background:#fff}',
    'body{box-sizing:border-box;padding:16px;display:flex;',
    'align-items:center;justify-content:center}',
    'img{width:100%;height:100%;object-fit:contain}</style>',
    `</head><body><img alt="" src="${src}"></body></html>`
  ].join('')
}
