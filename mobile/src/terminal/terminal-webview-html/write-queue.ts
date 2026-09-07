// Also carries disposeTermObservers() and extractMouseModeScanTail(): both belong to
// other concerns, but emitted-document order pins them inside this queue.
export const TERMINAL_HTML_WRITE_QUEUE = `  function resetWriteQueue() {
    writeQueue = [];
    writeQueueHead = 0;
  }

  function isStatusDotPresentationSelector(value) {
    return value === TEXT_PRESENTATION_SELECTOR || value === EMOJI_PRESENTATION_SELECTOR;
  }

  function endsWithStatusDotPresentationSequence(data) {
    var i = data.length - 1;
    while (i >= 0 && isStatusDotPresentationSelector(data.charAt(i))) i--;
    return i >= 0 && data.charAt(i) === CLAUDE_STATUS_DOT;
  }

  // Why: iOS WebKit promotes Claude's record/status dot to a colorful emoji glyph.
  function normalizeStatusDotPresentation(data) {
    if (typeof data !== 'string' || data.length === 0) return data;
    if (statusDotPendingSelector) {
      statusDotPendingSelector = false;
      var strippedPendingSelectors = false;
      while (data.length > 0 && isStatusDotPresentationSelector(data.charAt(0))) data = data.slice(1);
      strippedPendingSelectors = data.length === 0;
      if (strippedPendingSelectors) {
        statusDotPendingSelector = true;
        return '';
      }
    }
    var normalized = data.replace(CLAUDE_STATUS_DOT_PATTERN, CLAUDE_STATUS_DOT + TEXT_PRESENTATION_SELECTOR);
    statusDotPendingSelector = endsWithStatusDotPresentationSequence(data);
    return normalized;
  }

  function enqueueWrite(data) {
    writeQueue.push(normalizeStatusDotPresentation(data));
  }

  function enqueueWriteBoundary(callback) {
    writeQueue.push(callback);
  }

  function nextQueuedWrite() {
    if (writeQueueHead >= writeQueue.length) {
      resetWriteQueue();
      return undefined;
    }
    var next = writeQueue[writeQueueHead];
    writeQueueHead++;
    // Why: high-throughput terminals can enqueue faster than xterm parses;
    // compact consumed slots so drain work stays O(1) without retaining old chunks.
    if (writeQueueHead > 128 && writeQueueHead * 2 > writeQueue.length) {
      writeQueue = writeQueue.slice(writeQueueHead);
      writeQueueHead = 0;
    }
    return next;
  }

  function disposeTermObservers() {
    var disposables = termObserverDisposables;
    termObserverDisposables = [];
    for (var i = 0; i < disposables.length; i++) {
      try { disposables[i] && disposables[i].dispose && disposables[i].dispose(); } catch (e) {}
    }
  }

  function extractMouseModeScanTail(input) {
    var start = Math.max(input.lastIndexOf(ESC), input.lastIndexOf(C1_CSI));
    if (start === -1) return '';
    var tail = input.slice(start);
    // Why: PTY/SSH chunks can split a long combined DECSET before the final h/l.
    // Keep parser state far beyond normal mode lists while still bounding memory.
    if (tail.length > PRIVATE_MODE_SCAN_TAIL_LIMIT) return '';
    if (tail === ESC || tail === ESC + '[' || tail === C1_CSI) return tail;
    if (tail.indexOf(ESC + '[?') === 0) {
      return /^[0-9;]*$/.test(tail.slice(3)) ? tail : '';
    }
    if (tail.indexOf(C1_CSI + '?') === 0) {
      return /^[0-9;]*$/.test(tail.slice(2)) ? tail : '';
    }
    return '';
  }

  function pumpWrites(gen) {
    if (!ready || !term || writesDraining || gen !== terminalGeneration) return;
    var next = nextQueuedWrite();
    if (typeof next !== 'string') {
      if (typeof next === 'function') return next(), pumpWrites(gen);
      var callbacks = afterDrainCallbacks;
      afterDrainCallbacks = [];
      for (var i = 0; i < callbacks.length; i++) callbacks[i]();
      return;
    }
    writesDraining = true;
    // Why: xterm.write() parses asynchronously. Row adjustment/resizing must
    // wait until replayed SGR attributes have landed in the buffer.
    term.write(next, function() {
      if (gen !== terminalGeneration) return;
      writesDraining = false;
      pumpWrites(gen);
    });
  }

  function afterWritesDrained(callback) {
    afterDrainCallbacks.push(callback);
    pumpWrites(terminalGeneration);
  }

`
