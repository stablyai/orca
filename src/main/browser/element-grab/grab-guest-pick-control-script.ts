export const GRAB_PICK_CONTROL_SCRIPT = `  function pickControl(element, payload, contextMenu) {
    var original = new WeakRef(element);
    var response = { payload: payload, contextMenu: contextMenu };
    var hidden = null;
    function snapshot() {
      var target = original.deref();
      if (!target || !target.isConnected || target.ownerDocument !== document) return false;
      var rect = target.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: window.innerWidth };
    }
    return function(action, id) {
      if (action === 'payload') { var result = response; response = null; return result; }
      if (action === 'present') { var target = original.deref(); return Boolean(target && target.isConnected && target.ownerDocument === document); }
      if (action === 'snapshot') return snapshot();
      if (action === 'hide') {
        var rect = snapshot();
        if (!rect || hidden) return false;
        var nodes = [host].concat(Array.from(document.querySelectorAll('[data-orca-browser-annotation-overlay]')));
        hidden = { id: id, nodes: nodes.map(function(node) { return { node: node, display: node.style.display }; }) };
        hidden.nodes.forEach(function(item) { item.node.style.display = 'none'; });
        return rect;
      }
      if (action === 'restore' && hidden && hidden.id === id) {
        hidden.nodes.forEach(function(item) { item.node.style.display = item.display; });
        hidden = null;
        return true;
      }
      return false;
    };
  }`
