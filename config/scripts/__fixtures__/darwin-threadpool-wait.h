/* Copyright Joyent, Inc. and other Node contributors. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */

#ifndef THREADPOOL_DARWIN_WAIT_H_
#define THREADPOOL_DARWIN_WAIT_H_

#include "uv.h"
#include <dlfcn.h>
#include <mach/mach.h>
#include <mach/thread_status.h>
#include <pthread.h>
#include <stdint.h>
#include <string.h>

static int read_wait_generation(uv_thread_t worker,
                                uintptr_t* condition,
                                uint64_t* generation) {
  mach_msg_type_number_t count;
  kern_return_t result;
  uintptr_t pc;
  Dl_info symbol;
# if defined(__aarch64__)
  arm_thread_state64_t state = {0};
  count = ARM_THREAD_STATE64_COUNT;
  result = thread_get_state(pthread_mach_thread_np(worker),
                            ARM_THREAD_STATE64,
                            (thread_state_t) &state,
                            &count);
  pc = arm_thread_state64_get_pc(state);
  *generation = state.__x[1];
  *condition = state.__x[0];
# else
  x86_thread_state64_t state = {0};
  count = x86_THREAD_STATE64_COUNT;
  result = thread_get_state(pthread_mach_thread_np(worker),
                            x86_THREAD_STATE64,
                            (thread_state_t) &state,
                            &count);
  pc = state.__rip;
  *generation = state.__rsi;
  *condition = state.__rdi;
# endif
  if (result != KERN_SUCCESS)
    return 0;
  if (!dladdr((void*) pc, &symbol) || symbol.dli_sname == NULL)
    return 0;
  return strcmp(symbol.dli_sname, "__psynch_cvwait") == 0;
}

#endif
