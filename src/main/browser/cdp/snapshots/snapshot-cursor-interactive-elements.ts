import type { SnapshotEntry } from './snapshot-ax-tree-walk'
import type { CdpCommandSender } from './snapshot-engine'

// Find controls omitted from the accessibility tree, such as styled div buttons.
export async function findCursorInteractiveElements(
  sendCommand: CdpCommandSender,
  existingEntries: SnapshotEntry[]
): Promise<SnapshotEntry[]> {
  const existingNodeIds = new Set(existingEntries.map((e) => e.backendDOMNodeId))
  const results: SnapshotEntry[] = []

  try {
    const { result } = (await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const SKIP_ROLES = new Set(['button','link','textbox','checkbox','radio','tab',
          'menuitem','option','switch','slider','combobox','searchbox','spinbutton','treeitem',
          'menuitemcheckbox','menuitemradio']);
        const SKIP_TAGS = new Set(['input','button','select','textarea','a']);
        const seen = new Set();
        const found = [];
        const matchedElements = [];

        function check(el) {
          if (seen.has(el)) return;
          seen.add(el);
          const tag = el.tagName.toLowerCase();
          if (SKIP_TAGS.has(tag)) return;
          const role = el.getAttribute('role');
          if (role && SKIP_ROLES.has(role)) return;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return;
          const text = (el.ariaLabel || el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 80);
          if (!text) return;
          found.push({ text, tag });
          matchedElements.push(el);
          if (found.length >= 50) return;
        }

        document.querySelectorAll('[onclick], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]').forEach(el => {
          if (found.length < 50) check(el);
        });
        document.querySelectorAll('div, span, li, td, img, svg, label').forEach(el => {
          if (found.length >= 50) return;
          try {
            if (window.getComputedStyle(el).cursor === 'pointer') check(el);
          } catch {}
        });

        window.__orcaCursorInteractive = matchedElements;
        return JSON.stringify(found);
      })()`,
      returnByValue: true
    })) as { result: { value: string } }

    const elements = JSON.parse(result.value) as { text: string; tag: string }[]

    for (let i = 0; i < elements.length; i++) {
      try {
        const { result: objResult } = (await sendCommand('Runtime.evaluate', {
          expression: `window.__orcaCursorInteractive[${i}]`
        })) as { result: { objectId?: string } }

        if (!objResult.objectId) {
          continue
        }

        const { node } = (await sendCommand('DOM.describeNode', {
          objectId: objResult.objectId
        })) as { node: { backendNodeId: number } }

        if (existingNodeIds.has(node.backendNodeId)) {
          continue
        }

        results.push({
          ref: '',
          role: 'clickable',
          name: elements[i].text,
          backendDOMNodeId: node.backendNodeId,
          depth: 0
        })
      } catch {
        continue
      }
    }

    await sendCommand('Runtime.evaluate', {
      expression: 'delete window.__orcaCursorInteractive',
      returnByValue: true
    })
  } catch {
    // Supplementary DOM discovery may fail; retain any entries already found.
  }

  return results
}
