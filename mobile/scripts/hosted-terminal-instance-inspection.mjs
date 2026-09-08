export const HOSTED_TERMINAL_INSTANCE_LOOKUP = `function findTerminal(element) {
          for (
            let ancestor = element;
            ancestor instanceof HTMLElement;
            ancestor = ancestor.parentElement
          ) {
            const fiberKey = Object.keys(ancestor).find((key) => key.startsWith('__reactFiber$'));
            let fiber = fiberKey ? ancestor[fiberKey] : null;
            for (let depth = 0; fiber && depth < 32; depth += 1, fiber = fiber.return) {
              let hook = fiber.memoizedState;
              for (let index = 0; hook && index < 32; index += 1, hook = hook.next) {
                const current = hook.memoizedState?.current;
                if (
                  current &&
                  Number.isInteger(current.cols) &&
                  Number.isInteger(current.rows) &&
                  current.buffer?.active
                ) return current;
              }
            }
          }
          return null;
        }`
