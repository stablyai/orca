export const TERMINAL_WRITE_PUMP_JS = String.raw`
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
    scrollCoordinator.dispatch({ type: 'output-started', generation: gen });
    // Wait for xterm's async parse so replayed SGR attributes reach the buffer before resizing.
    term.write(next, function() {
      if (gen !== terminalGeneration) return;
      scrollCoordinator.dispatch({ type: 'output-committed', generation: gen });
      writesDraining = false;
      pumpWrites(gen);
    });
  }
`
